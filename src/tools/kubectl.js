// src/tools/kubectl.js

const { execFile } = require('child_process');

// Split a command string into an argument array, respecting double-quoted segments.
// Shell metacharacters (; | $ ` etc.) become harmless literal characters with execFile.
function _parseArgs(command) {
  const withoutBinary = command.replace(/^kubectl\s+/, '');
  const tokens = withoutBinary.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return tokens.map(t => {
    // --flag="quoted value" or --flag='quoted value' → --flag=value
    const flagQuoted = t.match(/^(--?[\w-]+=)["'](.*)["']$/);
    if (flagQuoted) return flagQuoted[1] + flagQuoted[2];
    // "standalone quoted token" → strip wrapping quotes
    return t.replace(/^["']|["']$/g, '');
  });
}

function runCommand(command, { timeoutMs = 60_000, impersonateAs = null } = {}) {
  return new Promise((resolve, reject) => {
    const args = _parseArgs(command);
    if (impersonateAs) {
      args.unshift(`--as=${impersonateAs}`);
    }
    const child = execFile(
      'kubectl', args,
      { maxBuffer: 10 * 1024 * 1024, timeout: timeoutMs },
      (error, stdout, stderr) => {
        if (error) {
          const msg = stderr?.trim() || error.message || 'Unknown kubectl error';
          return reject(new Error(msg));
        }
        resolve(stdout.trim());
      }
    );
    child.on('error', reject);
  });
}

/**
 * Get all pods from a namespace
 */
async function getPods(namespace = 'default', context, asJson = false) {
  // "*" means all namespaces — maps to --all-namespaces flag
  const nsFlag = namespace === '*' ? '--all-namespaces' : `-n ${namespace}`;
  const cmd = `kubectl --context=${context} get pods ${nsFlag}${asJson ? ' -o json' : ''}`;
  const out  = await runCommand(cmd);
  return asJson ? JSON.parse(out) : out;
}

/**
 * Describe a pod
 */
async function describePod(podName, namespace = 'default', context) {
  const cmd = `kubectl --context=${context} describe pod ${podName} -n ${namespace}`;

  return await runCommand(cmd);
}

/**
 * Get pod logs
 */
async function getLogs(podName, namespace = 'default', context) {
  const cmd = `kubectl --context=${context} logs ${podName} -n ${namespace} --tail=50`;

  return await runCommand(cmd);
}

/**
 * Restart deployment
 */
async function restartDeployment(
  deployment,
  namespace = 'default',
  context
) {
  const cmd = `kubectl --context=${context} rollout restart deployment/${deployment} -n ${namespace}`;

  return await runCommand(cmd);
}

/**
 * Scale deployment
 */
async function scaleDeployment(
  deployment,
  replicas,
  namespace = 'default',
  context
) {
  // Pre-flight: confirm the Deployment actually exists before scaling.
  // Without this, kubectl emits two concatenated stderr lines that look like
  // "no objects passed to scale deployments.apps "<name>" not found".
  try {
    await runCommand(`kubectl --context=${context} get deployment/${deployment} -n ${namespace} --no-headers`);
  } catch {
    throw new Error(
      `Deployment "${deployment}" not found in namespace "${namespace}". ` +
      `The pod may be a bare pod or managed by a ReplicaSet — use delete_pod instead.`
    );
  }

  const cmd = `kubectl --context=${context} scale deployment/${deployment} --replicas=${replicas} -n ${namespace}`;
  return await runCommand(cmd);
}

/**
 * Delete pod
 */
async function deletePod(podName, namespace = 'default', context) {
  const cmd = `kubectl --context=${context} delete pod ${podName} -n ${namespace}`;

  return await runCommand(cmd);
}

/**
 * Get all nodes
 */
async function getNodes(context) {
  const out = await runCommand(`kubectl --context=${context} get nodes -o json`);
  return JSON.parse(out);
}

/**
 * Get Kubernetes events (all namespaces)
 */
async function getEvents(context) {
  const out = await runCommand(`kubectl --context=${context} get events --all-namespaces -o json`);
  return JSON.parse(out);
}

/**
 * Cordon a node — mark unschedulable
 */
async function cordonNode(nodeName, context) {
  return await runCommand(`kubectl --context=${context} cordon ${nodeName}`);
}

/**
 * Uncordon a node — re-enable scheduling
 */
async function uncordonNode(nodeName, context) {
  return await runCommand(`kubectl --context=${context} uncordon ${nodeName}`);
}

/**
 * Drain a node — evict all non-DaemonSet pods
 */
async function drainNode(nodeName, context, { deleteEmptyDir = false, gracePeriod = 60 } = {}) {
  const deleteFlag = deleteEmptyDir ? ' --delete-emptydir-data' : '';
  return await runCommand(
    `kubectl --context=${context} drain ${nodeName}` +
    ` --ignore-daemonsets${deleteFlag} --timeout=${gracePeriod}s`
  );
}

// ── RBAC reads ────────────────────────────────────────────────────────────────

async function getRoles(namespace = 'default', context) {
  const nsFlag = namespace === '*' ? '--all-namespaces' : `-n ${namespace}`;
  const out = await runCommand(`kubectl --context=${context} get roles ${nsFlag} -o json`);
  return JSON.parse(out).items ?? [];
}

async function getClusterRoles(context) {
  const out = await runCommand(`kubectl --context=${context} get clusterroles -o json`);
  return JSON.parse(out).items ?? [];
}

async function getRoleBindings(namespace = 'default', context) {
  const nsFlag = namespace === '*' ? '--all-namespaces' : `-n ${namespace}`;
  const out = await runCommand(`kubectl --context=${context} get rolebindings ${nsFlag} -o json`);
  return JSON.parse(out).items ?? [];
}

async function getClusterRoleBindings(context) {
  const out = await runCommand(`kubectl --context=${context} get clusterrolebindings -o json`);
  return JSON.parse(out).items ?? [];
}

async function getServiceAccounts(namespace = 'default', context) {
  const nsFlag = namespace === '*' ? '--all-namespaces' : `-n ${namespace}`;
  const out = await runCommand(`kubectl --context=${context} get serviceaccounts ${nsFlag} -o json`);
  return JSON.parse(out).items ?? [];
}

async function getNamespaces(context) {
  const out = await runCommand(`kubectl --context=${context} get namespaces -o json`);
  return (JSON.parse(out).items ?? []).map(ns => ns.metadata.name);
}

// ── RBAC writes ───────────────────────────────────────────────────────────────

async function applyManifest(yamlContent, context) {
  const os   = require('os');
  const path = require('path');
  const fs   = require('fs');
  const tmp  = path.join(os.tmpdir(), `kp-rbac-${Date.now()}.yaml`);
  fs.writeFileSync(tmp, yamlContent, 'utf8');
  try {
    // Quote the path so spaces in os.tmpdir() don't split the argument on Windows/Linux
    return await runCommand(`kubectl --context="${context}" apply -f "${tmp}"`);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

async function dryRunManifest(yamlContent, context) {
  const os   = require('os');
  const path = require('path');
  const fs   = require('fs');
  const tmp  = path.join(os.tmpdir(), `kp-rbac-dry-${Date.now()}.yaml`);
  fs.writeFileSync(tmp, yamlContent, 'utf8');
  try {
    return await runCommand(`kubectl --context="${context}" apply --dry-run=server -f "${tmp}"`);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

const RBAC_KINDS   = new Set(['role', 'clusterrole', 'rolebinding', 'clusterrolebinding', 'serviceaccount']);
const SAFE_NAME_RE = /^[a-z0-9][a-z0-9\-\.]*$/i;

async function deleteRbacResource(kind, name, namespace, context) {
  if (!RBAC_KINDS.has(kind?.toLowerCase()))
    throw new Error(`Unsupported RBAC kind: ${kind}`);
  if (!SAFE_NAME_RE.test(name))
    throw new Error(`Invalid resource name: ${name}`);
  if (namespace && !SAFE_NAME_RE.test(namespace))
    throw new Error(`Invalid namespace: ${namespace}`);

  const nsFlag = namespace ? `-n "${namespace}"` : '';
  return await runCommand(`kubectl --context="${context}" delete ${kind} "${name}" ${nsFlag}`);
}

// ── CertificateSigningRequest (client-cert issuance for direct kubectl access) ──

// Submit a CSR using the cluster's built-in client-cert signer — works on managed
// clusters (AKS) as well as self-hosted ones, unlike signing directly with a local
// ca.key file (which managed clusters don't expose).
async function submitCsr(name, csrPemBase64, context) {
  const yamlLib  = require('js-yaml');
  const manifest = {
    apiVersion: 'certificates.k8s.io/v1',
    kind: 'CertificateSigningRequest',
    metadata: { name, labels: { 'app.kubernetes.io/managed-by': 'kubepilot' } },
    spec: {
      request:    csrPemBase64,
      signerName: 'kubernetes.io/kube-apiserver-client',
      usages:     ['client auth'],
    },
  };
  return applyManifest(yamlLib.dump(manifest), context);
}

async function approveCsr(name, context) {
  return runCommand(`kubectl --context="${context}" certificate approve "${name}"`);
}

// Returns the base64 DER certificate from status.certificate, or null if not yet issued.
async function getCsrCertificate(name, context) {
  const out = await runCommand(`kubectl --context="${context}" get csr "${name}" -o json`);
  const csr = JSON.parse(out);
  return csr.status?.certificate ?? null;
}

async function deleteCsr(name, context) {
  return runCommand(`kubectl --context="${context}" delete csr "${name}" --ignore-not-found`);
}

// Exports a self-contained kubeconfig for one context, using whatever credentials
// this server itself already has for it (--raw undoes the DATA+OMITTED redaction,
// --minify keeps only this context's cluster/user/context, --flatten inlines
// cert/key data so the file works standalone on another machine).
async function getRawKubeconfig(context) {
  return await runCommand(`kubectl --context="${context}" config view --raw --minify --flatten -o yaml`);
}

// Resolve a context's cluster server URL + CA data — needed to build a standalone
// kubeconfig for a user's client cert. Parses the whole raw kubeconfig as JSON rather
// than a jsonpath filter expression, since _parseArgs' tokenizer isn't built to survive
// jsonpath's own quoting/bracket syntax.
async function getClusterConnectionInfo(context) {
  const out = await runCommand('kubectl config view --raw -o json');
  const cfg = JSON.parse(out);
  const ctxEntry = (cfg.contexts ?? []).find(c => c.name === context);
  if (!ctxEntry) throw new Error(`Context "${context}" not found in kubeconfig`);
  const clusterName  = ctxEntry.context.cluster;
  const clusterEntry = (cfg.clusters ?? []).find(c => c.name === clusterName);
  if (!clusterEntry) throw new Error(`Cluster "${clusterName}" not found in kubeconfig`);
  return {
    clusterName,
    server:                clusterEntry.cluster.server,
    caData:                clusterEntry.cluster['certificate-authority-data'] ?? null,
    insecureSkipTlsVerify: !!clusterEntry.cluster['insecure-skip-tls-verify'],
  };
}

// ── Wait for a fix to settle (replaces blind sleep after _applyFix) ──────────
// Dispatches the right kubectl wait/rollout-status variant based on action type.
// Rejects on timeout — callers should catch and fall through to _validateFix.
async function waitForFix(issue, action, context, timeoutSecs = parseInt(process.env.KUBECTL_WAIT_TIMEOUT ?? '120', 10)) {
  const ns  = issue.namespace ?? 'default';
  const dep = issue.deployment;
  const pod = issue.podName;

  switch (action) {
    case 'restart':
    case 'rollback':
    case 'increase_memory':
    case 'scale_down':
      if (!dep) return;
      await runCommand(
        `kubectl --context=${context} rollout status deployment/${dep} -n ${ns} --timeout=${timeoutSecs}s`
      );
      return;

    case 'delete_pod':
      if (!pod) return;
      await runCommand(
        `kubectl --context=${context} wait pod/${pod} -n ${ns} --for=delete --timeout=${timeoutSecs}s`
      );
      return;

    default:
      // noop, cordon_node, etc. — no pod-level wait needed
  }
}

// ── Network reads ─────────────────────────────────────────────────────────────

async function getNetworkPolicies(namespace = 'default', context) {
  const nsFlag = namespace === '*' ? '--all-namespaces' : `-n ${namespace}`;
  const out = await runCommand(`kubectl --context="${context}" get networkpolicies ${nsFlag} -o json`);
  return JSON.parse(out).items ?? [];
}

async function getServices(namespace = 'default', context) {
  const nsFlag = namespace === '*' ? '--all-namespaces' : `-n ${namespace}`;
  const out = await runCommand(`kubectl --context="${context}" get services ${nsFlag} -o json`);
  return JSON.parse(out).items ?? [];
}

async function getIngresses(namespace = 'default', context) {
  const nsFlag = namespace === '*' ? '--all-namespaces' : `-n ${namespace}`;
  const out = await runCommand(`kubectl --context="${context}" get ingresses ${nsFlag} -o json`);
  return JSON.parse(out).items ?? [];
}

async function getEndpoints(namespace = 'default', context) {
  const nsFlag = namespace === '*' ? '--all-namespaces' : `-n ${namespace}`;
  const out = await runCommand(`kubectl --context="${context}" get endpoints ${nsFlag} -o json`);
  return JSON.parse(out).items ?? [];
}

// ── Network writes ────────────────────────────────────────────────────────────

const NETWORK_KINDS = new Set(['networkpolicy', 'service', 'ingress']);

async function deleteNetworkResource(kind, name, namespace, context) {
  if (!NETWORK_KINDS.has(kind?.toLowerCase()))
    throw new Error(`Unsupported network kind: ${kind}`);
  if (!SAFE_NAME_RE.test(name))
    throw new Error(`Invalid resource name: ${name}`);
  if (namespace && !SAFE_NAME_RE.test(namespace))
    throw new Error(`Invalid namespace: ${namespace}`);

  const nsFlag = namespace ? `-n "${namespace}"` : '';
  return await runCommand(`kubectl --context="${context}" delete ${kind} "${name}" ${nsFlag}`);
}

module.exports = {
  runCommand,
  waitForFix,
  getPods,
  describePod,
  getLogs,
  restartDeployment,
  scaleDeployment,
  deletePod,
  getNodes,
  getEvents,
  cordonNode,
  uncordonNode,
  drainNode,
  getRoles,
  getClusterRoles,
  getRoleBindings,
  getClusterRoleBindings,
  getServiceAccounts,
  getNamespaces,
  applyManifest,
  dryRunManifest,
  deleteRbacResource,
  submitCsr,
  approveCsr,
  getCsrCertificate,
  deleteCsr,
  getClusterConnectionInfo,
  getRawKubeconfig,
  getNetworkPolicies,
  getServices,
  getIngresses,
  getEndpoints,
  deleteNetworkResource,
  getPersistentVolumes,
  getPersistentVolumeClaims,
};

async function getPersistentVolumes(context) {
  const out = await runCommand(`kubectl --context="${context}" get pv -o json`);
  return JSON.parse(out).items ?? [];
}

async function getPersistentVolumeClaims(context) {
  const out = await runCommand(`kubectl --context="${context}" get pvc -A -o json`);
  return JSON.parse(out).items ?? [];
}