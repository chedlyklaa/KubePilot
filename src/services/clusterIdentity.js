'use strict';
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const yaml = require('js-yaml');
const { AsyncLocalStorage } = require('async_hooks');

// ── Per-role Kubernetes identities (reader / executor) ─────────────────────
// Today every cluster call authenticates with the "bootstrap" credential — the shared
// kubeconfig context or an uploaded ClusterCredential — and for minikube/cluster3 that is
// a client cert in O=system:masters, which skips Kubernetes RBAC entirely. So the
// read-only guarantee of the Investigator path was enforced only by app code
// (readOnlyKubectl.js), never by the cluster.
//
// With CLUSTER_IDENTITY_MODE=serviceaccount, code running inside
// withClusterIdentity('reader' | 'executor', fn) talks to the cluster as a dedicated
// ServiceAccount instead (deploy/k8s/target-cluster-rbac.yaml):
//
//   reader   → kubepilot-system/kubepilot-reader   — get/list/watch, NO secrets
//   executor → kubepilot-system/kubepilot-executor — reader + the narrow write verbs
//
// The token is minted on demand with the TokenRequest API (authenticated by the bootstrap
// credential), cached until shortly before it expires, and written into its OWN
// kubeconfig holding only that token — no client certificate, since a kubeconfig that
// still carried the system:masters cert would keep bypassing RBAC.
//
// The hook is sessionManager.getKubeconfigPath(), the one place both kubectl.runCommand()
// and k8sClient resolve credentials — so nothing else needs to know about identities.
//
// Fails CLOSED: in serviceaccount mode, if a role's token can't be minted the call errors
// out; it never silently falls back to the (system:masters) bootstrap credential.
// Code outside any withClusterIdentity() scope (dashboard API, chat, posture engines)
// keeps using the bootstrap credential, exactly as before.

const ROLES = {
  reader:   'kubepilot-reader',
  executor: 'kubepilot-executor',
};
const TOKEN_TTL_SEC        = 60 * 60;     // TokenRequest expirationSeconds (API minimum is 600)
const REFRESH_BEFORE_MS    = 10 * 60_000; // re-mint when less than this is left
const RUNTIME_DIR          = path.join(os.tmpdir(), 'kubepilot-runtime'); // same dir sessionManager uses

const als    = new AsyncLocalStorage();
const _cache = new Map();   // `${context}|${role}` -> { path, expiresAt }
const _minting = new Map(); // same key -> in-flight mint promise (no thundering herd)
let _mintSeq = 0;
// A superseded identity file is deleted only after this grace period: a kubectl call that
// resolved the old path just before the re-mint may not have spawned (and read it) yet.
// The old token itself is still valid for REFRESH_BEFORE_MS at that point.
const OLD_FILE_GRACE_MS = 2 * 60_000;

function identityMode() {
  return process.env.CLUSTER_IDENTITY_MODE === 'serviceaccount' ? 'serviceaccount' : 'bootstrap';
}

function identityNamespace() {
  return process.env.CLUSTER_IDENTITY_NAMESPACE || 'kubepilot-system';
}

function withClusterIdentity(role, fn) {
  if (!ROLES[role]) throw new Error(`unknown cluster identity role "${role}"`);
  return als.run(role, fn);
}

function currentIdentity() {
  return als.getStore() ?? null;
}

// Runs fn with NO identity scope — used for the bootstrap calls that mint tokens, which
// would otherwise recurse into getIdentityKubeconfigPath().
function withoutIdentity(fn) {
  return als.exit(fn);
}

// Bootstrap KubeConfig for `context`: the uploaded credential's file if there is one,
// else the server's shared kubeconfig — the same resolution kubectl/k8sClient use.
async function _bootstrapKubeConfig(context) {
  const k8s = require('@kubernetes/client-node');
  const sessionManager = require('./sessionManager');
  const credPath = await sessionManager.getBootstrapKubeconfigPath(context);
  const kc = new k8s.KubeConfig();
  if (credPath) kc.loadFromFile(credPath);
  else kc.loadFromDefault();
  kc.setCurrentContext(context);
  const cluster = kc.getCurrentCluster();
  if (!cluster) throw new Error(`no cluster entry for context "${context}" in the bootstrap kubeconfig`);
  return { kc, cluster };
}

// Pure: token-only kubeconfig for one (context, role). The context keeps its original
// name so callers' `--context=<name>` flags still resolve inside this file.
function renderIdentityKubeconfig({ context, role, cluster, token }) {
  const clusterBlock = { server: cluster.server };
  if (cluster.caData) clusterBlock['certificate-authority-data'] = cluster.caData;
  else if (cluster.caFile) clusterBlock['certificate-authority'] = cluster.caFile;
  if (cluster.skipTLSVerify) clusterBlock['insecure-skip-tls-verify'] = true;
  if (cluster.tlsServerName) clusterBlock['tls-server-name'] = cluster.tlsServerName;
  const user = `${context}-${role}`;
  return yaml.dump({
    apiVersion: 'v1',
    kind: 'Config',
    clusters: [{ name: context, cluster: clusterBlock }],
    users:    [{ name: user, user: { token } }],
    contexts: [{ name: context, context: { cluster: context, user } }],
    'current-context': context,
  });
}

async function _mint(context, role) {
  const k8s = require('@kubernetes/client-node');
  const { kc, cluster } = await _bootstrapKubeConfig(context);
  const api = kc.makeApiClient(k8s.CoreV1Api);
  let res;
  try {
    res = await api.createNamespacedServiceAccountToken({
      name: ROLES[role],
      namespace: identityNamespace(),
      body: { apiVersion: 'authentication.k8s.io/v1', kind: 'TokenRequest', spec: { expirationSeconds: TOKEN_TTL_SEC } },
    });
  } catch (err) {
    const detail = err?.body?.message ?? err?.message ?? String(err);
    throw new Error(
      `could not mint the ${role} token for context "${context}" (${identityNamespace()}/${ROLES[role]}): ${detail}. ` +
      'Apply deploy/k8s/target-cluster-rbac.yaml to that cluster, or set CLUSTER_IDENTITY_MODE=bootstrap.'
    );
  }
  const token = res?.status?.token;
  if (!token) throw new Error(`TokenRequest for ${ROLES[role]} on "${context}" returned no token`);
  const expiresAt = res.status.expirationTimestamp
    ? new Date(res.status.expirationTimestamp).getTime()
    : Date.now() + TOKEN_TTL_SEC * 1000;

  fs.mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });
  const safe = `${context}-${role}`.replace(/[^a-zA-Z0-9._-]/g, '_');
  // A NEW path per mint, never the previous one overwritten: k8sClient caches its API
  // clients keyed on this path, so reusing it would keep serving the expired token.
  const filePath = path.join(RUNTIME_DIR, `identity-${safe}-${process.pid}-${++_mintSeq}.yaml`);
  fs.writeFileSync(filePath, renderIdentityKubeconfig({ context, role, cluster, token }), { mode: 0o600 });
  console.log(`[ClusterIdentity] minted ${role} token for "${context}" (${identityNamespace()}/${ROLES[role]}), valid until ${new Date(expiresAt).toISOString()}`);
  return { path: filePath, expiresAt };
}

async function getIdentityKubeconfigPath(context, role) {
  const key = `${context}|${role}`;
  const cached = _cache.get(key);
  if (cached && cached.expiresAt - Date.now() > REFRESH_BEFORE_MS) return cached.path;

  if (!_minting.has(key)) {
    _minting.set(key, withoutIdentity(() => _mint(context, role))
      .then(entry => {
        const previous = _cache.get(key);
        _cache.set(key, entry);
        if (previous && previous.path !== entry.path) {
          setTimeout(() => { try { fs.unlinkSync(previous.path); } catch { /* already gone */ } }, OLD_FILE_GRACE_MS).unref();
        }
        return entry.path;
      })
      .finally(() => _minting.delete(key)));
  }
  return _minting.get(key);
}

// Called by sessionManager.getKubeconfigPath(): the identity file to use for this call,
// or undefined to fall through to the bootstrap credential.
async function resolveKubeconfigPath(context) {
  const role = currentIdentity();
  if (!role || identityMode() !== 'serviceaccount' || !context) return undefined;
  return getIdentityKubeconfigPath(context, role);
}

function invalidateIdentities(context) {
  for (const [key, entry] of _cache) {
    if (context && !key.startsWith(`${context}|`)) continue;
    try { fs.unlinkSync(entry.path); } catch { /* already gone */ }
    _cache.delete(key);
  }
}

module.exports = {
  withClusterIdentity, currentIdentity, withoutIdentity,
  identityMode, identityNamespace, resolveKubeconfigPath, getIdentityKubeconfigPath,
  renderIdentityKubeconfig, invalidateIdentities, ROLES,
};
