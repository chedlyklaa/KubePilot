'use strict';

// Uploaded, credential-backed clusters (see services/sessionManager.js) can go from
// working to silently broken — a rotated or expired token, a revoked service principal —
// with nothing but a stale "Failed to connect" line in the health page for whoever
// happens to look. Local kubeconfig contexts rarely fail this way on their own, so this
// wasn't much of a concern before uploads existed. Opt-in and notification-only — never
// mutates anything, just tells someone.

let _notifEngine = null;
function _getNotifEngine() {
  if (!_notifEngine) {
    try { _notifEngine = require('../services/notifications/engine'); } catch { /* not available */ }
  }
  return _notifEngine;
}

// Consecutive failed cycles before alerting — avoids paging on a single transient blip.
const FAILURE_THRESHOLD = parseInt(process.env.CONNECTIVITY_FAILURE_THRESHOLD ?? '3', 10);

class ConnectivityAlertEngine {
  constructor() {
    this._failCounts = new Map(); // cluster → consecutive failure count
    this._alerted    = new Set(); // clusters currently in an alerted (unreachable) state
  }

  // Called once per ClusterAgent cycle. `unreachable` should be true only when pods,
  // nodes, AND events all failed in the same cycle — a single failed call is more often
  // a narrow RBAC gap on one resource type than a real connectivity problem.
  async check(cluster, unreachable) {
    if (!unreachable) {
      if (this._alerted.has(cluster)) {
        const failedFor = this._failCounts.get(cluster) ?? 0;
        this._alerted.delete(cluster);
        this._failCounts.set(cluster, 0);

        const notifEngine = _getNotifEngine();
        if (notifEngine) {
          notifEngine.emit({
            severity: 'INFO',
            category: 'Cluster Connectivity',
            title:    `${cluster} reconnected`,
            message:  `KubePilot regained connectivity to "${cluster}" after ${failedFor} failed cycle(s).`,
          }).catch(() => {});
        }
      } else {
        this._failCounts.set(cluster, 0);
      }
      return;
    }

    const count = (this._failCounts.get(cluster) ?? 0) + 1;
    this._failCounts.set(cluster, count);

    if (count < FAILURE_THRESHOLD || this._alerted.has(cluster)) return;

    this._alerted.add(cluster);
    console.warn(`[CONNECTIVITY] ${cluster}: unreachable for ${count} consecutive cycle(s)`);

    const notifEngine = _getNotifEngine();
    if (notifEngine) {
      notifEngine.emit({
        severity: 'ERROR',
        category: 'Cluster Connectivity',
        title:    `${cluster} unreachable`,
        message:  `KubePilot has failed to connect to "${cluster}" for ${count} consecutive cycles. ` +
                   `Check credentials — a token or service principal may have expired or been rotated — and cluster availability.`,
      }).catch(() => {});
    }
  }
}

module.exports = new ConnectivityAlertEngine();
