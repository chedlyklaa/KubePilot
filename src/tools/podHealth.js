'use strict';
const kubectl = require('./kubectl');

// Same window used by orchestratorAgent.js's classifier for both container-restart and
// event recency — kept here as the single source of truth so the executor's post-fix
// verification and the pre-fix classifier agree on what "recent" means.
const RECENT_EVIDENCE_WINDOW_MS = 15 * 60 * 1000;

const DEFAULT_TIMEOUT_SECS = parseInt(process.env.KUBECTL_WAIT_TIMEOUT ?? '120', 10);
const POLL_INTERVAL_MS = 3_000;

// Moved here from orchestratorAgent.js (was duplicated logic waiting to happen) —
// verifying a fix and classifying a fresh incident both need the exact same answer to
// "is this container currently a problem", so there is only one definition.
function isActiveContainerProblem(cs) {
  if (!cs.ready) return true;
  if (cs.state?.waiting || cs.state?.terminated) return true;
  if (!(cs.restartCount > 0)) return false;
  const finishedAt = cs.lastState?.terminated?.finishedAt;
  if (!finishedAt) return true;
  return (Date.now() - new Date(finishedAt).getTime()) < RECENT_EVIDENCE_WINDOW_MS;
}

function _podIsHealthy(pod) {
  const phase = pod.status?.phase;
  const statuses = pod.status?.containerStatuses ?? [];
  if (phase === 'Succeeded') {
    return statuses.every(cs => !cs.state?.terminated || cs.state.terminated.exitCode === 0);
  }
  return phase === 'Running' && statuses.length > 0 && statuses.every(cs => !isActiveContainerProblem(cs));
}

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Polls `checkFn` (which itself hits the live cluster) until it reports healthy or
// `timeoutSecs` elapses — the generic shape every kind-specific verifier below shares.
async function _pollUntil(checkFn, timeoutSecs) {
  const deadline = Date.now() + timeoutSecs * 1000;
  let lastReason = 'timed out waiting for the resource to become healthy';
  for (;;) {
    const { healthy, reason } = await checkFn();
    if (healthy) return { healthy: true };
    lastReason = reason ?? lastReason;
    if (Date.now() >= deadline) return { healthy: false, reason: lastReason };
    await _sleep(POLL_INTERVAL_MS);
  }
}

async function _verifyPod({ target, issue, context, timeoutSecs, kubectlImpl }) {
  const namespace = target.namespace ?? issue?.namespace ?? 'default';
  return _pollUntil(async () => {
    let podsJson;
    try {
      podsJson = await kubectlImpl.getPods(namespace, context, true);
    } catch (err) {
      return { healthy: false, reason: `could not list pods: ${err.message}` };
    }
    const items = podsJson?.items ?? [];
    const named = items.find(p => p.metadata?.name === target.name);
    if (named) {
      return _podIsHealthy(named)
        ? { healthy: true }
        : { healthy: false, reason: `pod "${target.name}" is not yet healthy (phase=${named.status?.phase ?? 'unknown'})` };
    }

    // The named pod is gone — most likely the fix deleted it (e.g. "kubectl delete
    // pod") and its controller is expected to have recreated a replacement under the
    // same name prefix. Without a live controller reference for the deleted pod, this
    // is the same name-prefix convention already used elsewhere in this codebase
    // (_resolveController's pod-template-hash-suffix reasoning) rather than a fresh
    // label-selector round trip.
    const ownerName = issue?.deployment ?? null;
    if (!ownerName) {
      return { healthy: false, reason: `pod "${target.name}" no longer exists and no owning controller is known to find its replacement` };
    }
    const replacement = items.find(p => (p.metadata?.name ?? '').startsWith(`${ownerName}-`) && _podIsHealthy(p));
    return replacement
      ? { healthy: true }
      : { healthy: false, reason: `no healthy replacement pod found for deleted "${target.name}" under "${ownerName}"` };
  }, timeoutSecs);
}

// Deployment/StatefulSet/DaemonSet — same mechanism the legacy pipeline already used
// (kubectl.js's waitForFix), generalized from the old fixed action-name switch to
// whatever `target.kind` the v5 Planner attached to the step.
async function _verifyRollout({ target, context, timeoutSecs, kubectlImpl }) {
  const namespace = target.namespace ?? 'default';
  const kind = target.kind.toLowerCase();
  try {
    await kubectlImpl.runCommand(`kubectl --context=${context} rollout status ${kind}/${target.name} -n ${namespace} --timeout=${timeoutSecs}s`);
    return { healthy: true };
  } catch (err) {
    return { healthy: false, reason: `rollout status did not succeed: ${err.message}` };
  }
}

// §Fix-VerifyGenericKind (2026-09-21) — fallback for any target.kind not covered by a
// kind-specific verifier above. PlanStepSchema.target.kind is a free-form string (see
// schemas.js — the free-form Planner is not restricted to a fixed enum of resource
// kinds), so a step can legitimately target a Secret, ConfigMap, ServiceAccount,
// PersistentVolumeClaim, or anything else kubectl knows about. None of those have a
// "readiness" concept the way a workload or Node does — "does the object exist now" is
// the correct and only meaningful check for them, not something to refuse to verify.
// Confirmed live (2026-09-21): a Planner step that correctly created a missing Secret
// was reported unhealthy purely because 'Secret' wasn't one of the kinds specifically
// enumerated below — which then triggered the step's own rollback and deleted the
// Secret it had just successfully created, every single attempt. Kinds handled above
// stay on their own richer, kind-appropriate check (rollout status, pod phase, node
// conditions) precisely because mere existence isn't sufficient evidence for those —
// this is the fallback for everything else, not a replacement for them.
async function _verifyExists({ target, context, timeoutSecs, kubectlImpl }) {
  const namespace = target.namespace ?? 'default';
  const kind = target.kind.toLowerCase();
  return _pollUntil(async () => {
    try {
      await kubectlImpl.runCommand(`kubectl --context=${context} get ${kind} ${target.name} -n ${namespace}`);
      return { healthy: true };
    } catch (err) {
      return { healthy: false, reason: `${target.kind} "${target.name}" not found: ${err.message}` };
    }
  }, timeoutSecs);
}

async function _verifyNode({ target, context, timeoutSecs, expectUnschedulable, kubectlImpl }) {
  return _pollUntil(async () => {
    let nodesJson;
    try {
      nodesJson = await kubectlImpl.getNodes(context);
    } catch (err) {
      return { healthy: false, reason: `could not list nodes: ${err.message}` };
    }
    const node = (nodesJson?.items ?? []).find(n => n.metadata?.name === target.name);
    if (!node) return { healthy: false, reason: `node "${target.name}" not found` };

    const unschedulable = !!node.spec?.unschedulable;
    if (expectUnschedulable !== undefined && unschedulable !== expectUnschedulable) {
      return { healthy: false, reason: `node "${target.name}" schedulable=${!unschedulable}, expected schedulable=${!expectUnschedulable}` };
    }
    const readyCondition = (node.status?.conditions ?? []).find(c => c.type === 'Ready');
    if (readyCondition?.status !== 'True') {
      return { healthy: false, reason: `node "${target.name}" Ready condition is "${readyCondition?.status ?? 'Unknown'}"` };
    }
    return { healthy: true };
  }, timeoutSecs);
}

/**
 * Re-checks the LIVE cluster to confirm a plan step actually fixed what it targeted —
 * the missing half of the executor's honesty check (a successful kubectl exit code only
 * proves the command ran, not that anything was resolved; see graph.js's
 * §Fix-ExecutorHonesty). Never throws — every failure mode (timeout, API error, unknown
 * target kind) resolves to `{ healthy: false, reason }`.
 *
 * @param {object} step    { command, target: {kind, name, namespace} }
 * @param {object} opts    { issue, context, timeoutSecs, kubectl }
 *
 * `opts.kubectl` defaults to the real ./kubectl module — overridable so tests can inject
 * a fake without depending on Vitest mocking a plain CJS require() (this project is
 * "type": "commonjs", where vi.mock does not reliably intercept that; see
 * permissionService.test.js for the same injectable-dependency precedent).
 *
 * Any target.kind not specifically handled below falls to _verifyExists (a generic
 * "does the object exist now" check) rather than an automatic failure — see its own
 * comment for why that's correct instead of a "refuse to guess" default.
 */
async function verifyResourceHealthy(step, { issue, context, timeoutSecs = DEFAULT_TIMEOUT_SECS, kubectl: kubectlImpl = kubectl } = {}) {
  const target = step?.target;
  if (!target?.kind || !target?.name) {
    return { healthy: false, reason: 'step has no target to verify' };
  }

  switch (target.kind) {
    case 'Pod':
      return _verifyPod({ target, issue, context, timeoutSecs, kubectlImpl });
    case 'Deployment':
    case 'StatefulSet':
    case 'DaemonSet':
      return _verifyRollout({ target, context, timeoutSecs, kubectlImpl });
    case 'Node': {
      const command = String(step.command ?? '').toLowerCase();
      // "uncordon" won't false-match "cordon" (no word boundary between "un" and
      // "cordon") — same regex convention executor.js already relies on for this.
      const expectUnschedulable = /\buncordon\b/.test(command)
        ? false
        : (/\b(cordon|drain)\b/.test(command) ? true : undefined);
      return _verifyNode({ target, context, timeoutSecs, expectUnschedulable, kubectlImpl });
    }
    default:
      return _verifyExists({ target, context, timeoutSecs, kubectlImpl });
  }
}

module.exports = {
  verifyResourceHealthy,
  isActiveContainerProblem,
  RECENT_EVIDENCE_WINDOW_MS,
  DEFAULT_TIMEOUT_SECS,
};
