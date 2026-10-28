'use strict';
const kubectl = require('./kubectl');

const RECENT_EVIDENCE_WINDOW_MS = 15 * 60 * 1000;

const DEFAULT_TIMEOUT_SECS = parseInt(process.env.KUBECTL_WAIT_TIMEOUT ?? '120', 10);
const POLL_INTERVAL_MS = 3_000;

// Check if a container has an active problem
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

// Poll until a check passes or times out
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

// Verify a rollout finished
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

// Verify a resource exists
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

// Check that a step fixed its target
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
  isPodHealthy: _podIsHealthy,
  RECENT_EVIDENCE_WINDOW_MS,
  DEFAULT_TIMEOUT_SECS,
};
