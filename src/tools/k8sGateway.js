'use strict';
const { agentClient } = require('../mesh/agentClient');
const { RefuseError } = require('../mesh/envelope');

// ── Kubernetes gateways ────────────────────────────────────────────────────
// Every cluster access the v5 agents make goes through one of two clients:
//
//   k8sRead  — read-only: the allowlisted free-form command (readOnlyKubectl.js) plus the
//              few typed read helpers the pipeline uses directly, and post-execution
//              health verification
//   k8sWrite — mutating: apply one approved plan step, or validate one with
//              --dry-run=server (executor.js)
//
// AGENT_K8S_READ_MODE / AGENT_K8S_WRITE_MODE=remote moves them into their own services
// (agent-services/k8s-read.js, k8s-write.js). Those two are then the ONLY processes that
// need cluster credentials (sessionManager → Mongo ClusterCredential + the decryption
// key), and each can run under its own Kubernetes identity (read-only vs. write). The
// LLM agents keep only the ability to ASK.
//
// Inputs/outputs are plain JSON: { ..., context } in, string/parsed JSON out.

// Each API runs under its own Kubernetes identity (src/services/clusterIdentity.js): with
// CLUSTER_IDENTITY_MODE=serviceaccount, reads authenticate as kubepilot-reader (no write
// verbs, no Secrets — enforced by the cluster's RBAC, not just readOnlyKubectl.js) and
// writes as kubepilot-executor. dryRun is on the executor side on purpose:
// --dry-run=server is authorized exactly like the real write.
const { withClusterIdentity } = require('../services/clusterIdentity');
const asRole = (role, api) => Object.fromEntries(
  Object.entries(api).map(([method, fn]) => [method, input => withClusterIdentity(role, () => fn(input))])
);

const readApi = asRole('reader', {
  exec:               ({ command, context }) => require('./readOnlyKubectl').executeReadOnlyCommand(command, context),
  getNodes:           ({ context }) => require('./kubectl').getNodes(context),
  getDeploymentsFull: ({ namespace, context }) => require('./kubectl').getDeploymentsFull(namespace, context),
  getLogs:            ({ podName, namespace, context }) => require('./kubectl').getLogs(podName, namespace, context),
  getPods:            ({ namespace, context, asJson = true }) => require('./kubectl').getPods(namespace, context, asJson),
  verifyHealth:       ({ step, issue, context, timeoutSecs }) =>
    require('./podHealth').verifyResourceHealthy(step, { issue, context, ...(timeoutSecs ? { timeoutSecs } : {}) }),
});

const writeApi = asRole('executor', {
  apply:  ({ step, context }) => require('../agents/executor').execute(step, { context }),
  dryRun: ({ step, context }) => require('../agents/executor').dryRun(step, { context }),
});

const READ_METHODS  = Object.keys(readApi);
const WRITE_METHODS = Object.keys(writeApi);

const k8sRead  = agentClient('k8s-read',  READ_METHODS,  () => readApi);
const k8sWrite = agentClient('k8s-write', WRITE_METHODS, () => writeApi);

// Remote apply carries the orchestrator's authorization (src/mesh/writeAuth.js) — only the
// orchestrator's executor calls apply, and only it holds MESH_WRITE_SIGNING_KEY. dryRun
// stays unsigned: the Planner service calls it, and executor.dryRun can't mutate.
if (k8sWrite.mode === 'remote') {
  const { signWrite } = require('../mesh/writeAuth');
  const unsignedApply = k8sWrite.apply;
  k8sWrite.apply = (input, opts = {}) =>
    unsignedApply({ ...input, auth: signWrite(input, opts.taskId) }, opts);
}

// ── Gateway-side guard (service mode only) ─────────────────────────────────
// A remote caller's `context` is untrusted input. The gateway re-resolves it against its
// OWN view of the fleet (clusters.yaml, hot-reloaded) and refuses anything else — so an
// agent bug or a hallucinated cluster name can never point kubectl at a context this
// deployment doesn't manage. Same rule graph.js's _clusterFor already applies
// in-process, now enforced by the process that actually holds the credentials.
function assertKnownContext(context) {
  const known = require('../config/clusterConfig').getClusters().map(c => c.context);
  if (!context || !known.includes(context)) {
    throw new RefuseError(`unknown kube context "${context}" — this gateway manages: ${known.join(', ') || '(none)'}`);
  }
}

function guarded(api) {
  return Object.fromEntries(Object.entries(api).map(([method, fn]) => [method, input => {
    assertKnownContext(input?.context);
    return fn(input);
  }]));
}

// Write gateway: on top of the context check, an apply must carry a valid orchestrator
// authorization bound to this task id — reaching the stream is not enough (writeAuth.js).
function guardedWriteApi() {
  const { verifyWrite } = require('../mesh/writeAuth');
  return {
    ...guarded(writeApi),
    apply: (input, ctx) => {
      assertKnownContext(input?.context);
      verifyWrite(input, ctx?.env?.task?.id);
      return writeApi.apply(input);
    },
  };
}

module.exports = {
  k8sRead, k8sWrite,
  readApi, writeApi, READ_METHODS, WRITE_METHODS,
  guardedReadApi:  () => guarded(readApi),
  guardedWriteApi,
  assertKnownContext,
};
