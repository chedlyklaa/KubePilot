'use strict';

const { NODE_RESOURCE_PRESSURE_TYPES } = require('./nodeConditions');
const { loadConfig } = require('../config');

const MASS_FAILURE_THRESHOLD = loadConfig().MASS_FAILURE_THRESHOLD;

class ClusterAnalyzer {
  // Find cluster-wide incident patterns
  static analyze({ podIssues, nodeIssues, correlation, events, clusterName }) {
    const clusterIssues = [];

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

    const notReadyNodes = nodeIssues.filter(n => n.type === 'NodeNotReady').length;
    const pressureNodes = nodeIssues.filter(n =>
      NODE_RESOURCE_PRESSURE_TYPES.includes(n.type)
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

    const parts = [];
    if (podIssues.length)           parts.push(`${podIssues.length} pod issue(s)`);
    if (nodeIssues.length)          parts.push(`${nodeIssues.length} node issue(s)`);
    if (correlation.hotNodes.length) parts.push(`${correlation.hotNodes.length} hot node(s)`);
    if (clusterIssues.length)       parts.push(`${clusterIssues.length} cluster-level pattern(s)`);

    const summary = parts.length ? parts.join(', ') : 'no issues detected';

    return { clusterIssues, summary };
  }

  // Format cluster findings for the prompt
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
