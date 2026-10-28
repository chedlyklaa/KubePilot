const { execFile } = require('child_process');
const sessionManager = require('../services/sessionManager');
const k8sClient = require('./k8sClient');

// Split a command into arguments
function _parseArgs(command) {
  const withoutBinary = command.replace(/^kubectl\s+/, '');
  const tokens = withoutBinary.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return tokens.map(t => {
    const flagQuoted = t.match(/^(--?[\w-]+=)["'](.*)["']$/);
    if (flagQuoted) return flagQuoted[1] + flagQuoted[2];
    return t.replace(/^["']|["']$/g, '');
  });
}

// Run a kubectl command
async function runCommand(command, { impersonateAs = null } = {}) {
  const timeoutMs = 60_000;
  const args = _parseArgs(command);
  if (impersonateAs) {
    args.unshift(`--as=${impersonateAs}`);
  }

  const ctxArg  = args.find(a => a.startsWith('--context='));
  const context = ctxArg ? ctxArg.slice('--context='.length) : null;
  const kubeconfigPath = context ? await sessionManager.getKubeconfigPath(context) : null;
  const env = kubeconfigPath ? { ...process.env, KUBECONFIG: kubeconfigPath } : process.env;

  return new Promise((resolve, reject) => {
    const child = execFile(
      'kubectl', args,
      { maxBuffer: 10 * 1024 * 1024, timeout: timeoutMs, env },
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

// Get pods in a namespace
async function getPods(namespace = 'default', context, asJson = false) {
  if (asJson) {
    const api  = await k8sClient.getCoreV1Api(context);
    const list = namespace === '*'
      ? await api.listPodForAllNamespaces()
      : await api.listNamespacedPod({ namespace });
    return { items: list.items ?? [] };
  }
  const nsFlag = namespace === '*' ? '--all-namespaces' : `-n ${namespace}`;
  const cmd = `kubectl --context=${context} get pods ${nsFlag}`;
  return await runCommand(cmd);
}

// Describe a pod
async function describePod(podName, namespace = 'default', context) {
  const cmd = `kubectl --context=${context} describe pod ${podName} -n ${namespace}`;

  return await runCommand(cmd);
}

// Get pod logs
async function getLogs(podName, namespace = 'default', context) {
  const cmd = `kubectl --context=${context} logs ${podName} -n ${namespace} --tail=50`;

  return await runCommand(cmd);
}

// Restart a deployment
async function restartDeployment(
  deployment,
  namespace = 'default',
  context
) {
  const cmd = `kubectl --context=${context} rollout restart deployment/${deployment} -n ${namespace}`;

  return await runCommand(cmd);
}

// Scale a deployment
async function scaleDeployment(
  deployment,
  replicas,
  namespace = 'default',
  context
) {
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

// Delete a pod
async function deletePod(podName, namespace = 'default', context) {
  const cmd = `kubectl --context=${context} delete pod ${podName} -n ${namespace}`;

  return await runCommand(cmd);
}

// Get all nodes
async function getNodes(context) {
  const out = await runCommand(`kubectl --context=${context} get nodes -o json`);
  return JSON.parse(out);
}

// Get events in all namespaces
async function getEvents(context) {
  const out = await runCommand(`kubectl --context=${context} get events --all-namespaces -o json`);
  return JSON.parse(out);
}

// Get roles in a namespace
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

// Apply a manifest
async function applyManifest(yamlContent, context) {
  const os   = require('os');
  const path = require('path');
  const fs   = require('fs');
  const tmp  = path.join(os.tmpdir(), `kp-rbac-${Date.now()}.yaml`);
  fs.writeFileSync(tmp, yamlContent, 'utf8');
  try {
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

// Submit a certificate signing request
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

// Get the certificate of a CSR
async function getCsrCertificate(name, context) {
  const out = await runCommand(`kubectl --context="${context}" get csr "${name}" -o json`);
  const csr = JSON.parse(out);
  return csr.status?.certificate ?? null;
}

async function deleteCsr(name, context) {
  return runCommand(`kubectl --context="${context}" delete csr "${name}" --ignore-not-found`);
}

// Export the kubeconfig of a context
async function getRawKubeconfig(context) {
  return await runCommand(`kubectl --context="${context}" config view --raw --minify --flatten -o yaml`);
}

// Get the server URL and CA of a context
async function getClusterConnectionInfo(context) {
  const kubeconfigPath = await sessionManager.getKubeconfigPath(context);
  const flag = kubeconfigPath ? `--kubeconfig="${kubeconfigPath}"` : '';
  const out = await runCommand(`kubectl ${flag} config view --raw -o json`.trim());
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

// Wait for a fix to settle
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
  }
}

// Get network policies in a namespace
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
  deleteNetworkResource,
  getPersistentVolumes,
  getPersistentVolumeClaims,
  getResourceQuotas,
  getPodDisruptionBudgets,
  getHPAs,
  patchHPA,
  isMetricsServerAvailable,
  getCRDs,
  getNamespacesFull,
  getDeploymentsFull,
  getStatefulSetsFull,
  getDaemonSetsFull,
  getConfigMaps,
  getSecretsMetadata,
};

async function getPersistentVolumes(context) {
  const out = await runCommand(`kubectl --context="${context}" get pv -o json`);
  return JSON.parse(out).items ?? [];
}

async function getPersistentVolumeClaims(context) {
  const out = await runCommand(`kubectl --context="${context}" get pvc -A -o json`);
  return JSON.parse(out).items ?? [];
}

// Get resource quotas in a namespace
async function getResourceQuotas(namespace, context) {
  const nsFlag = namespace === '*' ? '--all-namespaces' : `-n ${namespace}`;
  const out = await runCommand(`kubectl --context="${context}" get resourcequota ${nsFlag} -o json`);
  return JSON.parse(out).items ?? [];
}

async function getPodDisruptionBudgets(namespace, context) {
  const nsFlag = namespace === '*' ? '--all-namespaces' : `-n ${namespace}`;
  const out = await runCommand(`kubectl --context="${context}" get pdb ${nsFlag} -o json`);
  return JSON.parse(out).items ?? [];
}

// Get HPAs in a namespace
async function getHPAs(namespace, context) {
  const nsFlag = namespace === '*' ? '--all-namespaces' : `-n ${namespace}`;
  const out = await runCommand(`kubectl --context="${context}" get hpa ${nsFlag} -o json`);
  return JSON.parse(out).items ?? [];
}

// Patch an HPA
async function patchHPA(name, namespace, { minReplicas, maxReplicas }, context) {
  const os   = require('os');
  const path = require('path');
  const fs   = require('fs');
  const spec = {};
  if (minReplicas != null) spec.minReplicas = minReplicas;
  if (maxReplicas != null) spec.maxReplicas = maxReplicas;

  const tmp = path.join(os.tmpdir(), `kp-hpa-patch-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify({ spec }), 'utf8');
  try {
    return await runCommand(`kubectl --context="${context}" patch hpa "${name}" -n ${namespace} --type=merge --patch-file="${tmp}"`);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

// Check if metrics-server is available
async function isMetricsServerAvailable(context) {
  try {
    await runCommand(`kubectl --context="${context}" get --raw /apis/metrics.k8s.io/v1beta1`);
    return true;
  } catch {
    return false;
  }
}

// Get CRDs
async function getCRDs(context) {
  const out = await runCommand(`kubectl --context="${context}" get crd -o json`);
  return JSON.parse(out).items ?? [];
}

// Get full namespace objects
async function getNamespacesFull(context) {
  const out = await runCommand(`kubectl --context="${context}" get namespace -o json`);
  return JSON.parse(out).items ?? [];
}

// Get full deployment objects
async function getDeploymentsFull(namespace, context) {
  const nsFlag = namespace === '*' ? '--all-namespaces' : `-n ${namespace}`;
  const out = await runCommand(`kubectl --context="${context}" get deployments ${nsFlag} -o json`);
  return JSON.parse(out).items ?? [];
}

async function getStatefulSetsFull(namespace, context) {
  const nsFlag = namespace === '*' ? '--all-namespaces' : `-n ${namespace}`;
  const out = await runCommand(`kubectl --context="${context}" get statefulsets ${nsFlag} -o json`);
  return JSON.parse(out).items ?? [];
}

async function getDaemonSetsFull(namespace, context) {
  const nsFlag = namespace === '*' ? '--all-namespaces' : `-n ${namespace}`;
  const out = await runCommand(`kubectl --context="${context}" get daemonsets ${nsFlag} -o json`);
  return JSON.parse(out).items ?? [];
}

// Get config maps in a namespace
async function getConfigMaps(namespace, context) {
  const nsFlag = namespace === '*' ? '--all-namespaces' : `-n ${namespace}`;
  const out = await runCommand(`kubectl --context="${context}" get configmaps ${nsFlag} -o json`);
  return JSON.parse(out).items ?? [];
}

// Get secret keys without values
async function getSecretsMetadata(namespace, context) {
  const nsFlag = namespace === '*' ? '--all-namespaces' : `-n ${namespace}`;
  const out = await runCommand(`kubectl --context="${context}" get secrets ${nsFlag} -o json`);
  const items = JSON.parse(out).items ?? [];
  return items.map(s => ({
    name:      s.metadata?.name,
    namespace: s.metadata?.namespace,
    type:      s.type,
    keys:      Object.keys(s.data ?? s.stringData ?? {}),
  }));
}