// src/audit/logger.js
'use strict';

const fs   = require('fs');
const path = require('path');

let AuditEvent;
try { ({ AuditEvent } = require('../db/models')); } catch {}

/**
 * Audit Logger
 * Append-only JSONL audit system
 */
class AuditLogger {
  constructor() {
    this.logDirectory = path.join(
      __dirname,
      '../../logs'
    );

    this.logFile = path.join(
      this.logDirectory,
      'audit.jsonl'
    );

    this.ensureLogDirectory();
  }

  /**
   * Create logs directory if missing
   */
  ensureLogDirectory() {
    if (!fs.existsSync(this.logDirectory)) {
      fs.mkdirSync(this.logDirectory, {
        recursive: true,
      });
    }
  }

  /**
   * Write audit event
   */
  log(event) {
    const auditEntry = {
      timestamp: new Date().toISOString(),

      cluster: event.cluster || 'unknown',

      agent: event.agent || 'unknown',

      action: event.action || 'unknown',

      decision: event.decision || 'unknown',

      riskScore: event.riskScore || 0,

      status: event.status || 'pending',

      reason: event.reason || null,

      metadata: event.metadata || {},
    };

    try {
      fs.appendFileSync(this.logFile, JSON.stringify(auditEntry) + '\n');
      console.log(`[AUDIT] Action logged: ${auditEntry.action}`);
    } catch (error) {
      console.error('[AUDIT] Failed to write audit log:', error);
    }

    // Async MongoDB write — non-blocking, JSONL is the primary fallback
    if (AuditEvent) {
      AuditEvent.create(auditEntry).catch(err =>
        console.warn(`[AUDIT] MongoDB write failed: ${err.message}`)
      );
    }
  }

  async getLogsMongo({ limit = 200, cluster = null, status = null, agent = null } = {}) {
    const filter = {};
    if (cluster) filter.cluster = cluster;
    if (status)  filter.status  = status;
    if (agent)   filter.agent   = agent;
    if (!AuditEvent) return this._filterLogs(this.getLogs(), { cluster, status, agent }).slice(0, limit);
    try {
      return await AuditEvent.find(filter).sort({ timestamp: -1 }).limit(limit).lean();
    } catch {
      return this._filterLogs(this.getLogs(), { cluster, status, agent }).slice(0, limit);
    }
  }

  _filterLogs(docs, { cluster, status, agent }) {
    if (cluster) docs = docs.filter(e => e.cluster === cluster);
    if (status)  docs = docs.filter(e => e.status  === status);
    if (agent)   docs = docs.filter(e => e.agent   === agent);
    return docs;
  }

  /**
   * Log successful execution
   */
  success(event) {
    this.log({
      ...event,
      status: 'success',
    });
  }

  /**
   * Log failed execution
   */
  failure(event) {
    this.log({
      ...event,
      status: 'failed',
    });
  }

  /**
   * Log blocked action
   */
  blocked(event) {
    this.log({
      ...event,
      status: 'blocked',
    });
  }

  /**
   * Read audit history
   */
  getLogs() {
    try {
      const content = fs.readFileSync(
        this.logFile,
        'utf8'
      );

      return content
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch (error) {
      console.error(
        '[AUDIT] Failed to read logs:',
        error
      );

      return [];
    }
  }
}

module.exports = new AuditLogger();