'use strict';

// Spatial correlation: groups pod failures by the node they're running on, to detect
// "hot nodes" (many unrelated pods failing on the same node — usually a node-level
// problem, not N independent app bugs). Distinct from changeCorrelationEngine.js, which
// does TEMPORAL correlation (does a recent deployment/config change explain this one
// incident). The near-identical original names (correlationEngine.js /
// changeCorrelationEngine.js) invited exactly the "is one of these dead?" confusion this
// file's rename is meant to remove — both are live, called from different places in
// ClusterAgent for different purposes.

const NODE_CORR_THRESHOLD = parseInt(process.env.NODE_CORR_THRESHOLD || '3', 10);
const NS_CORR_THRESHOLD   = parseInt(process.env.NS_CORR_THRESHOLD   || '2', 10);

class NodeHotspotCorrelator {
  /**
   * Map pod issues to nodes and find multi-pod failure patterns.
   *
   * @param {Array}  podIssues   - From PodAnalyzer.extractIssues()
   * @param {Array}  nodeIssues  - From NodeAnalyzer.extractIssues()
   * @param {object} podsJson    - Raw kubectl get pods -o json (all namespaces)
   * @param {Array}  events      - From EventAnalyzer.extractEvents()
   *
   * @returns {{
   *   podsByNode:    object,   // nodeName → [podName, ...]
   *   issuesByNode:  object,   // nodeName → [issue, ...]
   *   hotNodes:      Array,    // nodes with >= threshold failing pods
   *   findings:      Array,    // human-readable findings
   *   confidence:    number,   // 0–1 how confident the correlation is
   * }}
   */
  static correlate(podIssues, nodeIssues, podsJson, events = []) {
    // ── Build pod→node map from raw kubectl output ──────────────────────────
    const podNodeMap = {};   // "namespace/podName" → nodeName
    const nodePodMap = {};   // nodeName → [{ namespace, name }]

    for (const pod of podsJson?.items ?? []) {
      const ns      = pod.metadata?.namespace ?? 'default';
      const name    = pod.metadata?.name;
      const node    = pod.spec?.nodeName;
      if (!name || !node) continue;
      podNodeMap[`${ns}/${name}`] = node;
      if (!nodePodMap[node]) nodePodMap[node] = [];
      nodePodMap[node].push({ namespace: ns, name });
    }

    // ── Group pod issues by node ────────────────────────────────────────────
    const issuesByNode = {};
    for (const issue of podIssues) {
      const key  = `${issue.namespace}/${issue.podName}`;
      const node = podNodeMap[key];
      if (!node) continue;
      if (!issuesByNode[node]) issuesByNode[node] = [];
      issuesByNode[node].push(issue);
    }

    // ── Identify hot nodes ──────────────────────────────────────────────────
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

    // Sort: highest confidence first
    hotNodes.sort((a, b) => b.confidence - a.confidence);

    // ── Enrich issues with node context ────────────────────────────────────
    const podsByNode = {};
    for (const [node, pods] of Object.entries(nodePodMap)) {
      podsByNode[node] = pods;
    }

    // ── Build human-readable findings ──────────────────────────────────────
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

    // ── Scheduling pressure from events ────────────────────────────────────
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

  /**
   * Annotate each pod issue with the node it runs on (convenience helper).
   */
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
  score += Math.min(affectedPods / 10, 0.5);        // more pods → higher confidence
  score += Math.min(namespaceCount / 4, 0.3);        // cross-namespace → higher
  if (hasNodeIssue) score += 0.2;                    // node also has conditions
  return Math.min(Math.round(score * 100) / 100, 1.0);
}

module.exports = NodeHotspotCorrelator;
