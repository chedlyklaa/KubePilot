'use strict';

let TemporalEvent;
try { ({ TemporalEvent } = require('../db/models')); } catch {}

class TemporalMemory {
  constructor() {
    this.memory     = [];
    this.maxEntries = 100;
    this._initialized = false;
  }

  // Load recent events from MongoDB. Called explicitly from ClusterAgent.run()
  // on the first cycle so that detection methods read real history immediately.
  async initialize() {
    if (this._initialized || !TemporalEvent) return;
    this._initialized = true; // prevent concurrent init
    try {
      const recent = await TemporalEvent
        .find()
        .sort({ timestamp: -1 })
        .limit(this.maxEntries)
        .lean();
      const loaded = recent.reverse().map(e => ({
        timestamp: e.timestamp,
        cluster:   e.cluster,
        action:    e.action,
        status:    e.status,
        issue:     e.issue,
        riskScore: e.riskScore,
        metadata:  e.metadata,
      }));
      // Prepend history before any entries added during the async window so
      // chronological order is preserved and in-flight entries are not lost.
      this.memory = [...loaded, ...this.memory].slice(-this.maxEntries);
      console.log(`[TemporalMemory] Loaded ${loaded.length} entries from MongoDB`);
    } catch (err) {
      console.warn(`[TemporalMemory] Could not load from MongoDB: ${err.message}`);
      this._initialized = false; // allow retry on next initialize() call
    }
  }

  add(event) {

    const memoryEntry = {
      timestamp: new Date().toISOString(),
      cluster:   event.cluster,
      action:    event.action,
      status:    event.status,
      issue:     event.issue,
      riskScore: event.riskScore || 0,
      metadata:  event.metadata  || {},
    };

    this.memory.push(memoryEntry);
    if (this.memory.length > this.maxEntries) this.memory.shift();

    // Persist to MongoDB asynchronously — non-blocking
    if (TemporalEvent) {
      TemporalEvent.create(memoryEntry).catch(err =>
        console.warn(`[TemporalMemory] MongoDB write failed: ${err.message}`)
      );
    }

    console.log(`[MEMORY] Event stored: ${event.action}`);
  }

  getRecentEvents(limit = 10) {
    return this.memory.slice(-limit);
  }

  getRecentFailures(limit = 5) {
    return this.memory.filter(e => e.status === 'failed').slice(-limit);
  }

  getClusterHistory(clusterName) {
    return this.memory.filter(e => e.cluster === clusterName);
  }

  detectRepeatedFailures(issueType) {
    const failures = this.memory.filter(e => e.issue === issueType && e.status === 'failed');
    return failures.length >= 3;
  }

  detectRiskPattern() {
    const recentHighRisk = this.memory.filter(e => e.riskScore > 0.7);
    return {
      highRiskCount:          recentHighRisk.length,
      requiresHumanAttention: recentHighRisk.length >= 5,
    };
  }

  clear() {
    this.memory = [];
    console.log('[MEMORY] Memory cleared');
  }
}

module.exports = new TemporalMemory();
