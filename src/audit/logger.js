// src/audit/logger.js

const fs = require('fs');
const path = require('path');

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
      // JSONL format
      fs.appendFileSync(
        this.logFile,
        JSON.stringify(auditEntry) + '\n'
      );

      console.log(
        `[AUDIT] Action logged: ${auditEntry.action}`
      );
    } catch (error) {
      console.error(
        '[AUDIT] Failed to write audit log:',
        error
      );
    }
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