'use strict';

const MASS_FAILURE_THRESHOLD = parseInt(process.env.MASS_FAILURE_THRESHOLD || '5', 10);

class ClusterAnalyzer {
  /**
   * Identify cluster-wide incident patterns from the combined findings.
   *
   * @param {object} params
   * @param {Array}  params.podIssues        - From PodAnalyzer
   * @param {Array}  params.nodeIssues       - From NodeAnalyzer
   * @param {object} params.correlation      - From CorrelationEngine.correlate()
   * @param {Array}  params.events           - From EventAnalyzer
   * @param {string} params.clusterName
   *
   * @returns {{ clusterIssues: Array, summary: string }}
   */
  static analyze({ podIssues, nodeIssues, correlation, events, clusterName }) {
    const clusterIssues = [];

    // ── MassPodFailure ──────────────────────────────────────────────────────
    if (podIssues.length >= MASS_FAILURE_THRESHOLD) {
      const namespaces = [...new Set(podIssues.map(i => i.namespace))];
      const types      = [...new Set(podIssues.map(i => i.type))];
      clusterIssues.push({
        type:          'MassPodFailure',
        clusterName,
        affectedPods:  podIssues.length,
        namespaces,
        issueTypes:    types,
        severity:      podIssues.length >= MASS_FAILURE_THRESHOLD * 2 ? 'critical' : 'high',
        message:       `${podIssues.length} pods failing across ${namespaces.length} namespace(s)`,
      });
    }

    // ── SchedulingFailure ───────────────────────────────────────────────────
    const schedEvents = events.filter(e => e.reason === 'FailedScheduling');
    if (schedEvents.length >= 3) {
      const affectedPods = [...new Set(schedEvents.map(e => e.name))];
      clusterIssues.push({
        type:          'SchedulingFailure',
        clusterName,
        eventCount:    schedEvents.length,
        affectedPods:  affectedPods.length,
        severity:      'high',
        message:       `${schedEvents.length} FailedScheduling events for ${affectedPods.length} pod(s) — cluster may lack capacity or nodes are tainted/cordoned`,
      });
    }

    // ── ClusterDegradation ─────────────────────────────────────────────────
    const notReadyNodes = nodeIssues.filter(n => n.type === 'NodeNotReady').length;
    const pressureNodes = nodeIssues.filter(n =>
      ['NodeMemoryPressure','NodeDiskPressure','NodePIDPressure'].includes(n.type)
    ).length;

    if (notReadyNodes >= 2 || (notReadyNodes >= 1 && pressureNodes >= 1)) {
      clusterIssues.push({
        type:          'ClusterDegradation',
        clusterName,
        notReadyNodes,
        pressureNodes,
        severity:      notReadyNodes >= 2 ? 'critical' : 'high',
        message:       `Cluster degradation: ${notReadyNodes} NotReady node(s), ${pressureNodes} node(s) under resource pressure`,
      });
    }

    // ── Build summary text ─────────────────────────────────────────────────
    const parts = [];
    if (podIssues.length)           parts.push(`${podIssues.length} pod issue(s)`);
    if (nodeIssues.length)          parts.push(`${nodeIssues.length} node issue(s)`);
    if (correlation.hotNodes.length) parts.push(`${correlation.hotNodes.length} hot node(s)`);
    if (clusterIssues.length)       parts.push(`${clusterIssues.length} cluster-level pattern(s)`);

    const summary = parts.length ? parts.join(', ') : 'no issues detected';

    return { clusterIssues, summary };
  }

  /**
   * Format cluster findings as a text block for LLM prompt injection.
   */
  static formatForPrompt({ clusterIssues, correlation, clusterName }) {
    const lines = [];

    if (correlation.hotNodes.length) {
      lines.push('\nNODE CORRELATION FINDINGS');
      for (const h of correlation.hotNodes) {
        lines.push(
          `  • node="${h.nodeName}"  failing-pods=${h.affectedPods}` +
          `  namespaces=${h.namespaces.join(',')}` +
          `  node-conditions=${h.hasNodeIssue}` +
          `  confidence=${h.confidence}`
        );
      }
    }

    if (clusterIssues.length) {
      lines.push('\nCLUSTER-LEVEL PATTERNS');
      for (const ci of clusterIssues) {
        lines.push(`  • [${ci.type}] ${ci.message}`);
      }
    }

    return lines.join('\n');
  }
}

module.exports = ClusterAnalyzer;
