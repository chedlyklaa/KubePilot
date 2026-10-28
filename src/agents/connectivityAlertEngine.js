'use strict';

let _notifEngine = null;
function _getNotifEngine() {
  if (!_notifEngine) {
    try { _notifEngine = require('../services/notifications/engine'); } catch { }
  }
  return _notifEngine;
}

const FAILURE_THRESHOLD = parseInt(process.env.CONNECTIVITY_FAILURE_THRESHOLD ?? '3', 10);

class ConnectivityAlertEngine {
  constructor() {
    this._failCounts = new Map();
    this._alerted    = new Set();
  }

  // Check cluster connectivity and alert
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
