'use strict';

// Turns the existing manual "Sync from K8s" button (POST /api/rbac/sync-from-k8s,
// see rbacSync.syncFromK8s) into a periodic background check. Without this, KubePilot's
// stored User.permissions only reflects reality up to whenever an admin last remembered
// to click that button — anyone editing RoleBindings directly on the cluster (kubectl,
// another tool) causes silent drift in the meantime. Opt-in: mutates permission data,
// so it shouldn't change behavior for anyone who hasn't explicitly enabled it.

let _rbacSync     = null;
let _RbacAuditLog = null;
let _notifEngine  = null;

function _initModels() {
  if (_rbacSync) return;
  try { _rbacSync = require('../services/rbacSync'); } catch { /* not available */ }
  try { ({ RbacAuditLog: _RbacAuditLog } = require('../db/models')); } catch { /* MongoDB unavailable */ }
}

function _getNotifEngine() {
  if (!_notifEngine) {
    try { _notifEngine = require('../services/notifications/engine'); } catch { /* not available */ }
  }
  return _notifEngine;
}

const DRIFT_INTERVAL_CYCLES = parseInt(process.env.RBAC_DRIFT_INTERVAL_CYCLES ?? '10', 10);

class RbacDriftEngine {
  constructor() {
    this._cycleCount = 0;
    this._running    = false; // prevents concurrent drift checks (same pattern as CapacityForecastEngine)
  }

  // Called from ClusterAgent.run() — non-blocking, fire-and-forget, feature-flagged.
  async checkDrift({ cluster, context }) {
    _initModels();
    if (!_rbacSync) return;

    this._cycleCount++;
    if (this._cycleCount % DRIFT_INTERVAL_CYCLES !== 0) return;

    if (this._running) {
      console.log('[RBAC-DRIFT] Previous check still running — skipping cycle');
      return;
    }
    this._running = true;

    try {
      const result  = await _rbacSync.syncFromK8s(context);
      const changed = (result.updated?.length ?? 0) + (result.cleared?.length ?? 0);
      if (changed === 0) return;

      console.log(`[RBAC-DRIFT] ${cluster}: reconciled ${changed} user(s) — stored permissions no longer matched live RBAC`);

      _RbacAuditLog?.create({
        userId:    'system',
        userEmail: 'rbac-drift-engine',
        action:    'apply',
        kind:      'UserPermissionsSync',
        name:      `auto-reconciled ${changed} user(s)`,
        context,
        timestamp: new Date(),
      }).catch(err => console.warn('[RBAC-DRIFT] Audit log write failed:', err.message));

      const notifEngine = _getNotifEngine();
      if (notifEngine) {
        const parts = [];
        if (result.updated?.length) parts.push(`${result.updated.length} updated`);
        if (result.cleared?.length) parts.push(`${result.cleared.length} revoked`);
        notifEngine.emit({
          severity: 'WARNING',
          category: 'RBAC Drift',
          title:    `RBAC drift detected on ${cluster}`,
          message:  `Live Kubernetes RBAC no longer matched KubePilot's stored permissions (${parts.join(', ')}) — auto-reconciled from the cluster.`,
          metadata: result,
        }).catch(() => {});
      }
    } catch (err) {
      console.warn(`[RBAC-DRIFT] ${cluster}: check failed (non-blocking): ${err.message}`);
    } finally {
      this._running = false;
    }
  }
}

module.exports = new RbacDriftEngine();
