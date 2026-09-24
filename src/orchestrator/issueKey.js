'use strict';

// Shared dedup/tracking key for both raw incidents (Orchestrator's classification —
// { scope, nodeName, podName, deployment, namespace }) and adapted issues (graph.js's
// _toIssue() output — same field names, minus `scope`). Used consistently across
// orchestratorAgent.js (dedup/queue/lock keys), graph.js (issueTrackerStore/
// escalationStore/approvalStore keys), and planner.js/investigator.js (Short Memory
// keys) — previously reimplemented independently in all four files with subtly
// different fallback behavior (orchestratorAgent.js checked the explicit `scope`
// field and had an `?? 'unknown'` fallback; the others inferred node-vs-pod from
// field presence and had no fallback, so a pathological issue with neither
// deployment nor podName would have produced a key ending in "/undefined").
// Unified here so a future change can't desync them the way the reflexionNode
// timeline-outcome vocabulary already did.
//
// Cluster-prefixed since the fleet-wide multi-cluster redesign: two different clusters
// can legitimately have an identically-named namespace+resource (or node), and without
// a cluster segment they'd collide on the exact same Redis key here — same incident
// state, cooldown, attempt count, and lock shared across two genuinely unrelated
// incidents. `clusterName` is expected on every caller's object by this point (raw
// incidents from orchestratorAgent.js's classifier always carry it; graph.js's
// _toIssue() carries it through from the incident it was built from) — `?? 'unknown'`
// is a last-resort fallback only, not a normal path.
function issueKey(obj) {
  const cluster = obj.clusterName ?? 'unknown';
  const isNodeScoped = obj.scope === 'node' || (obj.scope == null && !!obj.nodeName && !obj.podName);
  if (isNodeScoped) return `${cluster}/node:${obj.nodeName}`;
  const resource = obj.deployment ?? obj.podName ?? 'unknown';
  return `${cluster}/${obj.namespace ?? 'default'}/${resource}`;
}

module.exports = { issueKey };
