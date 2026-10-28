'use strict';

let AuditEvent;
try { ({ AuditEvent } = require('../db/models')); } catch {}

// Writes audit events to MongoDB
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

  // Log a successful execution
  success(event) {
    this.log({ ...event, status: 'success' });
  }

  // Log a failed execution
  failure(event) {
    this.log({ ...event, status: 'failed' });
  }

  // Log a blocked action
  blocked(event) {
    this.log({ ...event, status: 'blocked' });
  }
}

module.exports = new AuditLogger();
