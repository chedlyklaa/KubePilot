'use strict';

// Build the tracking key for an issue
function issueKey(obj) {
  const cluster = obj.clusterName ?? 'unknown';
  const isNodeScoped = obj.scope === 'node' || (obj.scope == null && !!obj.nodeName && !obj.podName);
  if (isNodeScoped) return `${cluster}/node:${obj.nodeName}`;
  const resource = obj.deployment ?? obj.podName ?? 'unknown';
  return `${cluster}/${obj.namespace ?? 'default'}/${resource}`;
}

module.exports = { issueKey };
