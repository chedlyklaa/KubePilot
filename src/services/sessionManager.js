'use strict';
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const crypto = require('crypto');
const yaml   = require('js-yaml');
const { execFile } = require('child_process');
const notifCrypto = require('./notifications/crypto');
const { ClusterCredential } = require('../db/models');

// Private runtime directory for materialized per-cluster kubeconfigs. Swept clean on
// every boot (initRuntimeDir), rather than relying solely on shutdown handlers — a
// SIGKILL or hard crash never runs those, so the startup sweep is the actual guarantee
// that no stale credential file survives a restart.
const RUNTIME_DIR = path.join(os.tmpdir(), 'kubepilot-runtime');

// context → { version, path } — in-memory only, rebuilt on demand from the DB.
const _cache = new Map();

function initRuntimeDir() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(RUNTIME_DIR, 0o700); } catch { /* best-effort on platforms without POSIX perms */ }
  for (const f of fs.readdirSync(RUNTIME_DIR)) {
    try { fs.unlinkSync(path.join(RUNTIME_DIR, f)); } catch { /* ignore, not critical */ }
  }
}

// Deterministic, collision-free context name for an uploaded cluster — prefixed so it
// can never collide with a context that already exists in the server's shared
// kubeconfig file (e.g. "cluster2", "minikube").
function canonicalContext(clusterName) {
  const safe = clusterName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return `kp-${safe}`;
}

// Parses a kubeconfig and returns its single context/cluster/user entries — shared by
// normalizeKubeconfig() and testConnection() so both apply the exact same "must be a
// single-cluster kubeconfig" rule instead of validating it twice, differently.
function _extractSingleContext(rawText) {
  let cfg;
  try { cfg = yaml.load(rawText); }
  catch (err) { throw new Error(`Kubeconfig is not valid YAML: ${err.message}`); }

  const contexts = cfg?.contexts ?? [];
  if (contexts.length !== 1) {
    throw new Error(
      `Kubeconfig must contain exactly one context (found ${contexts.length}). ` +
      `Export a single-cluster kubeconfig before uploading, e.g.: kubectl config view --minify --flatten`
    );
  }
  const ctxEntry     = contexts[0];
  const clusterEntry = (cfg.clusters ?? []).find(c => c.name === ctxEntry.context.cluster);
  const userEntry    = (cfg.users    ?? []).find(u => u.name === ctxEntry.context.user);
  if (!clusterEntry || !userEntry)
    throw new Error('Kubeconfig is missing the cluster or user entry referenced by its context');

  return { ctxEntry, clusterEntry, userEntry };
}

// Rewrites an uploaded kubeconfig so its single context/cluster/user are all named
// `canonicalName`. Every command string built throughout kubectl.js references
// clusters.yaml's `context` field, so the materialized file's internal context name
// must match it exactly, regardless of what the original upload called its context.
function _buildNormalizedYaml({ ctxEntry, clusterEntry, userEntry }, canonicalName) {
  return yaml.dump({
    apiVersion: 'v1',
    kind: 'Config',
    'current-context': canonicalName,
    clusters: [{ name: canonicalName, cluster: clusterEntry.cluster }],
    users:    [{ name: canonicalName, user: userEntry.user }],
    contexts: [{
      name: canonicalName,
      context: { cluster: canonicalName, user: canonicalName, namespace: ctxEntry.context.namespace ?? 'default' },
    }],
  });
}

function normalizeKubeconfig(rawText, canonicalName) {
  return _buildNormalizedYaml(_extractSingleContext(rawText), canonicalName);
}

// Proves the cluster in a kubeconfig actually exists and is reachable, without
// persisting anything — a short-lived temp file (deleted immediately after), never the
// runtime dir used for long-lived sessions. `cluster-info` is the standard smoke test
// for "is this kubeconfig valid and can I reach the API server": it fails clearly on
// DNS/network/TLS problems ("Unable to connect to the server") as well as a rejected
// credential ("Unauthorized"), which is exactly what "cluster exists and can connect"
// needs to rule out before anything gets saved.
async function testConnection(rawText) {
  _extractSingleContext(rawText); // structural validation, same rule as normalizeKubeconfig

  const dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-test-'));
  const file = path.join(dir, 'kubeconfig.yaml');
  try {
    fs.writeFileSync(file, rawText, { mode: 0o600 });
    await new Promise((resolve, reject) => {
      execFile(
        'kubectl',
        ['--kubeconfig', file, '--request-timeout=10s', 'cluster-info'],
        { timeout: 15_000 },
        (error, stdout, stderr) => {
          if (error) {
            const msg = stderr?.trim() || error.message || 'Could not connect to the cluster';
            return reject(new Error(msg));
          }
          resolve(stdout);
        }
      );
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function _materialize(encryptedConfig, context) {
  const { kubeconfig } = notifCrypto.decrypt(encryptedConfig);
  if (!kubeconfig) throw new Error(`Stored credential for "${context}" could not be decrypted`);
  const filePath = path.join(RUNTIME_DIR, `${crypto.randomUUID()}.yaml`);
  fs.writeFileSync(filePath, kubeconfig, { mode: 0o600 });
  try { fs.chmodSync(filePath, 0o600); } catch { /* best-effort on platforms without POSIX perms */ }
  return filePath;
}

// Returns a materialized kubeconfig path for this context, or null if no stored
// credential exists for it — callers fall back to the server's shared kubeconfig file
// in that case, which is the hybrid path: existing clusters keep working unchanged.
//
// No caller (including ClusterAgent) holds onto this path across calls — it's
// re-resolved on every single kubectl invocation via kubectl.js's runCommand(), so a
// rotated credential takes effect on the very next call, with no restart or reconcile
// needed. The in-memory cache below only avoids re-decrypting/re-writing the file on
// every call when nothing has changed.
async function getKubeconfigPath(context) {
  const cached = _cache.get(context);
  if (cached) return cached.path;

  const cred = await ClusterCredential.findOne({ context }).lean();
  if (!cred) return null;

  const filePath = _materialize(cred.encryptedConfig, context);
  _cache.set(context, { version: cred.version, path: filePath });
  return filePath;
}

// Called right after an admin uploads/rotates a credential. Deletes the cached temp
// file so the next kubectl call re-decrypts and re-materializes the fresh version.
function invalidate(context) {
  const cached = _cache.get(context);
  if (!cached) return;
  try { fs.unlinkSync(cached.path); } catch { /* already gone */ }
  _cache.delete(context);
}

// Normalizes, de-dupes, verifies, encrypts, and upserts a cluster's kubeconfig in one
// call — the only entry point routes should use, so nothing outside this file needs to
// know about encryption, the ClusterCredential schema, or the connectivity/duplicate
// checks. Both checks are mandatory here (not just optional UI steps), so a bad or
// duplicate kubeconfig can never end up stored, however this function gets called.
// Returns the canonical context name to register in clusters.yaml.
async function storeCredential({ name, rawKubeconfig, uploadedBy }) {
  const context   = canonicalContext(name);
  const extracted = _extractSingleContext(rawKubeconfig);
  const server    = extracted.clusterEntry.cluster.server;

  // Same server already registered under a different cluster name — almost certainly
  // the same physical cluster uploaded twice, which would otherwise get monitored (and
  // acted on) twice under two identities. Excludes `context` itself so re-uploading the
  // same cluster to rotate its credential isn't mistaken for a duplicate of itself.
  const duplicate = await ClusterCredential.findOne({ server, context: { $ne: context } }).select('clusterName').lean();
  if (duplicate) {
    throw new Error(
      `This cluster (${server}) is already registered as "${duplicate.clusterName}". ` +
      `Delete that entry first if you want to re-add it under a different name.`
    );
  }

  const normalized = _buildNormalizedYaml(extracted, context);
  await testConnection(normalized);
  const encryptedConfig = notifCrypto.encrypt({ kubeconfig: normalized });

  const existing = await ClusterCredential.findOne({ context }).select('version').lean();
  const version = (existing?.version ?? 0) + 1;

  try {
    await ClusterCredential.findOneAndUpdate(
      { context },
      { context, clusterName: name, server, encryptedConfig, version, uploadedBy },
      { upsert: true }
    );
  } catch (err) {
    // Race-condition backstop for the duplicate check above (unique index on `server`).
    if (err.code === 11000) throw new Error(`This cluster (${server}) is already registered under a different name.`);
    throw err;
  }
  invalidate(context);
  return context;
}

// Fully removes an uploaded cluster's credential — deletes the encrypted DB row and
// its cached temp kubeconfig file, if one was materialized. Callers are also
// responsible for dropping the matching entry from clusters.yaml, if present.
async function deleteCredential(context) {
  invalidate(context);
  await ClusterCredential.deleteOne({ context });
}

module.exports = {
  initRuntimeDir,
  canonicalContext,
  normalizeKubeconfig,
  testConnection,
  getKubeconfigPath,
  invalidate,
  storeCredential,
  deleteCredential,
};
