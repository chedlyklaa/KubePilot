'use strict';

// Fallback plan when the LLM is unavailable
function plan(issue, reason) {
  const type    = (issue.type ?? '').toLowerCase();
  const oomKill = !!(issue.oomKilled);

  let action, risk, rootCause, rationale, confidence;

  if (type.includes('crashloopbackoff')) {
    action     = 'restart';
    risk       = 'MEDIUM';
    rootCause  = 'CrashLoopBackOff detected — LLM unavailable, applying conservative restart';
    rationale  = 'Restart is the safest automated recovery for a crash-looping deployment when full LLM reasoning is unavailable.';
    confidence = 0.80;

  } else if (type.includes('oomkilled') || oomKill) {
    action     = 'restart';
    risk       = 'MEDIUM';
    rootCause  = 'OOMKilled — LLM unavailable; restart applied (memory limit increase deferred to human review)';
    rationale  = 'Restart buys time. Increasing memory limits requires human approval and is escalated separately.';
    confidence = 0.50;

  } else if (
    type.includes('nodenotready') ||
    type.includes('nodememory')   ||
    type.includes('nodedisk')
  ) {
    action     = 'cordon_node';
    risk       = 'MEDIUM';
    rootCause  = 'Node condition detected — LLM unavailable; cordoning to prevent new scheduling';
    rationale  = 'Cordon is the safest first-step for a degraded node. Drain requires LLM reasoning about blast radius.';
    confidence = 0.70;

  } else if (type.includes('imagepull') || type.includes('errimagepull')) {
    action     = 'noop';
    risk       = 'LOW';
    rootCause  = 'ImagePullBackOff — LLM unavailable; kubectl cannot fix image or registry credential issues';
    rationale  = 'No safe automated action exists. Escalating for human review.';
    confidence = 0.90;

  } else {
    action     = 'noop';
    risk       = 'LOW';
    rootCause  = `Issue type "${issue.type ?? 'unknown'}" — LLM unavailable; deferring to human escalation`;
    rationale  = 'Conservative default: no automated action without LLM reasoning.';
    confidence = 0.60;
  }

  console.warn(
    `[FallbackPlanner] pod plan activated — issue=${issue.type}` +
    `  action=${action}  reason=${reason}  confidence=${confidence}`
  );

  return {
    rootCause,
    failureOrigin: 'pod',
    action,
    targetNode:    null,
    risk,
    rationale,
    confidence,
    fallbackUsed:  true,
    reason,
  };
}

// Fallback plan for a node issue
function planNodeAction(nodeIssue, reason) {
  const type = (nodeIssue.type ?? '').toLowerCase();

  let action, risk, rootCause, rationale;

  if (type.includes('nodenotready')) {
    action    = 'cordon_node';
    risk      = 'MEDIUM';
    rootCause = 'NodeNotReady — LLM unavailable; cordoning node to prevent new scheduling';
    rationale = 'Cordon is the safest automated first-step for a NotReady node without LLM reasoning.';
  } else {
    action    = 'noop';
    risk      = 'LOW';
    rootCause = `Node condition "${nodeIssue.type ?? 'unknown'}" — LLM unavailable; deferring to human escalation`;
    rationale = 'Conservative default: no automated node action without LLM reasoning.';
  }

  console.warn(
    `[FallbackPlanner] node plan activated — type=${nodeIssue.type}` +
    `  node=${nodeIssue.nodeName}  action=${action}  reason=${reason}`
  );

  return {
    rootCause,
    action,
    targetNode:   nodeIssue.nodeName,
    risk,
    rationale,
    fallbackUsed: true,
    reason,
  };
}

module.exports = { plan, planNodeAction };
