'use strict';

const { CONDITION_TO_ISSUE_TYPE: CONDITION_ISSUE } = require('./nodeConditions');
const { loadConfig } = require('../config');

const _config = loadConfig();

// CPU saturation threshold (fraction, e.g. 0.90 = 90%)
const CPU_SAT_THRESHOLD  = _config.NODE_CPU_SAT_THRESHOLD;
const MEM_SAT_THRESHOLD  = _config.NODE_MEM_SAT_THRESHOLD;
// Flapping: ≥ N Ready→NotReady transitions within the window
const FLAP_TRANSITIONS   = _config.NODE_FLAP_TRANSITIONS;
const FLAP_WINDOW_MS     = _config.NODE_FLAP_WINDOW_MS;

class NodeAnalyzer {
  /**
   * Analyse raw `kubectl get nodes -o json` output.
   *
   * @param {object}  nodesData   - Parsed JSON from kubectl (items array)
   * @param {object}  nodeHistory - Map of nodeName → { transitions: [{at, ready}] }
   *                                Mutated in-place to track flapping.
   * @param {object}  nodeMetrics - Optional map of nodeName → { cpu, memory } from Prometheus
   * @returns {Array} issues
   */
  static extractIssues(nodesData, nodeHistory = {}, nodeMetrics = {}) {
    const issues = [];

    for (const node of nodesData.items ?? []) {
      const name       = node.metadata?.name;
      const labels     = node.metadata?.labels ?? {};
      const conditions = node.status?.conditions ?? [];
      const isControlPlane =
        labels['node-role.kubernetes.io/control-plane'] !== undefined ||
        labels['node-role.kubernetes.io/master']        !== undefined;

      // ── Ready condition ─────────────────────────────────────────────────
      const readyCond  = conditions.find(c => c.type === 'Ready');
      const isReady    = readyCond?.status === 'True';
      const lastChange = readyCond?.lastTransitionTime;

      // Track state history for flapping detection
      const hist = nodeHistory[name] ?? (nodeHistory[name] = { transitions: [] });
      const last = hist.transitions.at(-1);
      if (!last || last.ready !== isReady) {
        hist.transitions.push({ at: Date.now(), ready: isReady });
        // Keep only transitions within 2× the window
        const cutoff = Date.now() - FLAP_WINDOW_MS * 2;
        hist.transitions = hist.transitions.filter(t => t.at >= cutoff);
      }

      // NodeNotReady
      if (!isReady && readyCond) {
        issues.push({
          type:          'NodeNotReady',
          nodeName:      name,
          isControlPlane,
          reason:        readyCond.reason   ?? 'Unknown',
          message:       readyCond.message  ?? null,
          lastChange,
        });
      }

      // NodeFlapping — count Ready↔NotReady transitions inside the window
      const windowStart  = Date.now() - FLAP_WINDOW_MS;
      const recentTrans  = hist.transitions.filter(t => t.at >= windowStart);
      // Count direction-changes (ignore the very first entry)
      const flipCount    = recentTrans.reduce((n, t, i) =>
        i > 0 && t.ready !== recentTrans[i - 1].ready ? n + 1 : n, 0);
      if (flipCount >= FLAP_TRANSITIONS) {
        issues.push({
          type:          'NodeFlapping',
          nodeName:      name,
          isControlPlane,
          flipCount,
          windowMs:      FLAP_WINDOW_MS,
          reason:        'Repeated Ready/NotReady transitions detected',
          message:       `${flipCount} transitions in the last ${Math.round(FLAP_WINDOW_MS / 60000)} minutes`,
          lastChange,
        });
      }

      // Pressure conditions (MemoryPressure, DiskPressure, PIDPressure, NetworkUnavailable)
      for (const cond of conditions) {
        const issueType = CONDITION_ISSUE[cond.type];
        if (!issueType) continue;
        if (cond.status !== 'True') continue;
        issues.push({
          type:          issueType,
          nodeName:      name,
          isControlPlane,
          condition:     cond.type,
          reason:        cond.reason  ?? cond.type,
          message:       cond.message ?? null,
          lastChange:    cond.lastTransitionTime,
        });
      }

      // CPU / Memory saturation from Prometheus
      const m = nodeMetrics[name];
      if (m) {
        if (m.cpu?.avgPct != null && m.cpu.avgPct / 100 > CPU_SAT_THRESHOLD) {
          issues.push({
            type:          'NodeCpuSaturation',
            nodeName:      name,
            isControlPlane,
            cpuPct:        m.cpu.avgPct,
            cpuTrend:      m.cpu.trend,
            reason:        `CPU utilization ${m.cpu.avgPct}% exceeds threshold ${CPU_SAT_THRESHOLD * 100}%`,
            message:       null,
          });
        }
        if (m.memory?.usedPct != null && m.memory.usedPct / 100 > MEM_SAT_THRESHOLD) {
          issues.push({
            type:          'NodeMemorySaturation',
            nodeName:      name,
            isControlPlane,
            memPct:        m.memory.usedPct,
            memTrend:      m.memory.trend,
            reason:        `Memory utilization ${m.memory.usedPct}% exceeds threshold ${MEM_SAT_THRESHOLD * 100}%`,
            message:       null,
          });
        }
      }
    }

    return issues;
  }

  /** Build a quick nodeName → { isReady, isControlPlane, conditions } lookup. */
  static buildNodeMap(nodesData) {
    const map = {};
    for (const node of nodesData.items ?? []) {
      const name   = node.metadata?.name;
      const labels = node.metadata?.labels ?? {};
      const conds  = node.status?.conditions ?? [];
      const ready  = conds.find(c => c.type === 'Ready');
      map[name] = {
        isReady:        ready?.status === 'True',
        isControlPlane: !!(labels['node-role.kubernetes.io/control-plane'] || labels['node-role.kubernetes.io/master']),
        conditions:     Object.fromEntries(conds.map(c => [c.type, c.status === 'True'])),
        allocatable:    node.status?.allocatable ?? {},
      };
    }
    return map;
  }
}

module.exports = NodeAnalyzer;
