'use strict';

const NODE_CORR_THRESHOLD = parseInt(process.env.NODE_CORR_THRESHOLD || '3', 10);
const NS_CORR_THRESHOLD   = parseInt(process.env.NS_CORR_THRESHOLD   || '2', 10);

class NodeHotspotCorrelator {
  // Find nodes with many failing pods
  static correlate(podIssues, nodeIssues, podsJson, events = []) {
    const podNodeMap = {};
    const nodePodMap = {};

    for (const pod of podsJson?.items ?? []) {
      const ns      = pod.metadata?.namespace ?? 'default';
      const name    = pod.metadata?.name;
      const node    = pod.spec?.nodeName;
      if (!name || !node) continue;
      podNodeMap[`${ns}/${name}`] = node;
      if (!nodePodMap[node]) nodePodMap[node] = [];
      nodePodMap[node].push({ namespace: ns, name });
    }

    const issuesByNode = {};
    for (const issue of podIssues) {
      const key  = `${issue.namespace}/${issue.podName}`;
      const node = podNodeMap[key];
      if (!node) continue;
      if (!issuesByNode[node]) issuesByNode[node] = [];
      issuesByNode[node].push(issue);
    }

    const hotNodes = [];
    for (const [node, issues] of Object.entries(issuesByNode)) {
      if (issues.length < NODE_CORR_THRESHOLD) continue;
      const namespaces  = [...new Set(issues.map(i => i.namespace))];
      const issueTypes  = [...new Set(issues.map(i => i.type))];
      const hasNodeIssue = nodeIssues.some(n => n.nodeName === node);
      hotNodes.push({
        nodeName:      node,
        affectedPods:  issues.length,
        namespaces,
        issueTypes,
        hasNodeIssue,
        confidence:    _confidence(issues.length, namespaces.length, hasNodeIssue),
      });
    }

    hotNodes.sort((a, b) => b.confidence - a.confidence);

    const podsByNode = {};
    for (const [node, pods] of Object.entries(nodePodMap)) {
      podsByNode[node] = pods;
    }

    const findings = [];

    for (const h of hotNodes) {
      const detail =
        `${h.affectedPods} failing pods on node "${h.nodeName}"` +
        ` across ${h.namespaces.length} namespace(s)` +
        (h.hasNodeIssue ? ` — node also has active conditions` : '') +
        `. Issue types: ${h.issueTypes.join(', ')}.`;
      findings.push({
        level:    'node',
        nodeName: h.nodeName,
        message:  detail,
        confidence: h.confidence,
        action_hint: h.hasNodeIssue ? 'cordon_node' : 'investigate_node',
      });
    }

    const schedEvents = events.filter(e => e.reason === 'FailedScheduling');
    if (schedEvents.length >= 3) {
      findings.push({
        level:    'cluster',
        message:  `${schedEvents.length} FailedScheduling events detected — cluster may be resource-exhausted or tainted.`,
        confidence: 0.7,
        action_hint: 'check_cluster_capacity',
      });
    }

    const overallConfidence = hotNodes.length
      ? Math.max(...hotNodes.map(h => h.confidence))
      : 0;

    return { podsByNode, issuesByNode, hotNodes, findings, confidence: overallConfidence };
  }

  // Add the node name to each pod issue
  static annotatePodIssues(podIssues, podsJson) {
    const podNodeMap = {};
    for (const pod of podsJson?.items ?? []) {
      const key = `${pod.metadata?.namespace ?? 'default'}/${pod.metadata?.name}`;
      podNodeMap[key] = pod.spec?.nodeName ?? null;
    }
    return podIssues.map(issue => ({
      ...issue,
      nodeName: podNodeMap[`${issue.namespace}/${issue.podName}`] ?? null,
    }));
  }
}

function _confidence(affectedPods, namespaceCount, hasNodeIssue) {
  let score = 0;
  score += Math.min(affectedPods / 10, 0.5);
  score += Math.min(namespaceCount / 4, 0.3);
  if (hasNodeIssue) score += 0.2;
  return Math.min(Math.round(score * 100) / 100, 1.0);
}

module.exports = NodeHotspotCorrelator;
