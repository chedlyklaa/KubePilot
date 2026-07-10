// src/audit/logger.js
'use strict';

let AuditEvent;
try { ({ AuditEvent } = require('../db/models')); } catch {}

/**
 * Audit Logger
 * Writes to the AuditEvent Mongo collection (queried by /api/audit) — the
 * sole source of truth. Writes are fire-and-forget so a slow or unavailable
 * DB never blocks the calling agent/policy code.
 */
class AuditLogger {
  log(event) {
    const auditEntry = {
      timestamp: new Date().toISOString(),
      cluster:   event.cluster  || 'unknown',
      agent:     event.agent    || 'unknown',
      action:    event.action   || 'unknown',
      decision:  event.decision || 'unknown',
      riskScore: event.riskScore || 0,
      status:    event.status   || 'pending',
      reason:    event.reason   || null,
      metadata:  event.metadata || {},
    };

    console.log(`[AUDIT] Action logged: ${auditEntry.action}`);

    if (AuditEvent) {
      AuditEvent.create(auditEntry).catch(err =>
        console.warn(`[AUDIT] MongoDB write failed: ${err.message}`)
      );
    }
  }

  async getLogsMongo({ limit = 200, cluster = null, status = null, agent = null } = {}) {
    if (!AuditEvent) return [];
    const filter = {};
    if (cluster) filter.cluster = cluster;
    if (status)  filter.status  = status;
    if (agent)   filter.agent   = agent;
    try {
      return await AuditEvent.find(filter).sort({ timestamp: -1 }).limit(limit).lean();
    } catch (err) {
      console.warn(`[AUDIT] MongoDB read failed: ${err.message}`);
      return [];
    }
  }

  /**
   * Log successful execution
   */
  success(event) {
    this.log({ ...event, status: 'success' });
  }

  /**
   * Log failed execution
   */
  failure(event) {
    this.log({ ...event, status: 'failed' });
  }

  /**
   * Log blocked action
   */
  blocked(event) {
    this.log({ ...event, status: 'blocked' });
  }
}

module.exports = new AuditLogger();
