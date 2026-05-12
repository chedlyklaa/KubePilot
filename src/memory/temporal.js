// src/memory/temporal.js

/**
 * Temporal Memory System
 *
 * Stores recent actions and failures
 * to give historical context to the agent.
 */

class TemporalMemory {
  constructor() {
    // In-memory storage (temporary version)
    this.memory = [];

    // Keep only recent events
    this.maxEntries = 100;
  }

  /**
   * Store a new memory event
   */
  add(event) {
    const memoryEntry = {
      timestamp: new Date().toISOString(),

      cluster: event.cluster,

      action: event.action,

      status: event.status,

      issue: event.issue,

      riskScore: event.riskScore || 0,

      metadata: event.metadata || {},
    };

    this.memory.push(memoryEntry);

    // Trim old entries
    if (this.memory.length > this.maxEntries) {
      this.memory.shift();
    }

    console.log(
      `[MEMORY] Event stored: ${event.action}`
    );
  }

  /**
   * Get all recent events
   */
  getRecentEvents(limit = 10) {
    return this.memory.slice(-limit);
  }

  /**
   * Get recent failures
   */
  getRecentFailures(limit = 5) {
    return this.memory
      .filter((event) => event.status === 'failed')
      .slice(-limit);
  }

  /**
   * Get events by cluster
   */
  getClusterHistory(clusterName) {
    return this.memory.filter(
      (event) => event.cluster === clusterName
    );
  }

  /**
   * Detect repeated failures
   */
  detectRepeatedFailures(issueType) {
    const failures = this.memory.filter(
      (event) =>
        event.issue === issueType &&
        event.status === 'failed'
    );

    return failures.length >= 3;
  }

  /**
   * Detect repeated dangerous actions
   */
  detectRiskPattern() {
    const recentHighRisk = this.memory.filter(
      (event) => event.riskScore > 0.7
    );

    return {
      highRiskCount: recentHighRisk.length,

      requiresHumanAttention:
        recentHighRisk.length >= 5,
    };
  }

  /**
   * Clear memory
   */
  clear() {
    this.memory = [];

    console.log('[MEMORY] Memory cleared');
  }
}

module.exports = new TemporalMemory();