'use strict';
const { createClient } = require('redis');
const { loadConfig }   = require('../config');

const INCIDENT_TTL_SEC  = 24 * 60 * 60;
const DEFAULT_LOCK_TTL_MS = 5 * 60 * 1000;

function incidentKey(key)  { return `sm:incident:${key}`; }
function lockKey(key)      { return `sm:lock:${key}`; }
function attemptsKey(key)  { return `sm:attempts:${key}`; }
function cooldownKey(key)  { return `sm:cooldown:${key}`; }
// Redis key of the incident queue
function queueKey()  { return 'sm:queue:fleet'; }
function activeKey() { return 'sm:active:fleet'; }
function groupKey(group)   { return `sm:group:${group}`; }
function pinKey(key)       { return `sm:pin:${key}`; }

class ShortMemory {
  constructor() {
    this.client = null;
    this.ready  = false;
  }

  async initialize() {
    try {
      const { REDIS_URL } = loadConfig();
      this.client = createClient({ url: REDIS_URL });
      this.client.on('error', err => console.error('[ShortMemory] Redis error:', err.message));
      await this.client.connect();
      this.ready = true;
      console.log(`[ShortMemory] Connected to Redis (${REDIS_URL})`);
    } catch (err) {
      console.error('[ShortMemory] Init failed:', err.message);
      console.warn('[ShortMemory] Redis unavailable — Orchestrator dedup/queue/locks disabled for this run');
      this.ready = false;
    }
  }

  // Save incident state
  async upsertIncident(key, incident) {
    if (!this.ready) return;
    await this.client.set(incidentKey(key), JSON.stringify(incident), { EX: INCIDENT_TTL_SEC });
  }

  async getIncident(key) {
    if (!this.ready) return null;
    const raw = await this.client.get(incidentKey(key));
    return raw ? JSON.parse(raw) : null;
  }

  async resolveIncident(key) {
    if (!this.ready) return;
    await Promise.all([
      this.client.del(incidentKey(key)),
      this.client.del(attemptsKey(key)),
      this.client.del(cooldownKey(key)),
    ]);
  }

  // Acquire a lock on a resource
  async acquireResourceLock(key, workflowId, ttlMs = DEFAULT_LOCK_TTL_MS) {
    if (!this.ready) return true;
    const result = await this.client.set(lockKey(key), workflowId, { NX: true, PX: ttlMs });
    return result === 'OK';
  }

  async releaseResourceLock(key) {
    if (!this.ready) return;
    await this.client.del(lockKey(key));
  }

  // Add an incident to the priority queue
  async enqueue(key, priority) {
    if (!this.ready) return;
    await this.client.zAdd(queueKey(), [{ score: priority, value: key }]);
  }

  async dequeue(maxCount) {
    if (!this.ready || maxCount <= 0) return [];
    const keys = await this.client.zRange(queueKey(), 0, maxCount - 1, { REV: true });
    if (keys.length) await this.client.zRem(queueKey(), keys);
    return keys;
  }

  async queueDepth() {
    if (!this.ready) return 0;
    return this.client.zCard(queueKey());
  }

  // Increment the attempt counter
  async incrementAttempt(key) {
    if (!this.ready) return 1;
    const n = await this.client.incr(attemptsKey(key));
    await this.client.expire(attemptsKey(key), INCIDENT_TTL_SEC);
    return n;
  }

  async attemptCount(key) {
    if (!this.ready) return 0;
    const n = await this.client.get(attemptsKey(key));
    return n ? parseInt(n, 10) : 0;
  }

  async setCooldown(key, ttlMs) {
    if (!this.ready) return;
    await this.client.set(cooldownKey(key), '1', { PX: ttlMs });
  }

  async cooldownActive(key) {
    if (!this.ready) return false;
    return (await this.client.exists(cooldownKey(key))) === 1;
  }

  // Count active workflows
  async activeWorkflowCount() {
    if (!this.ready) return 0;
    return this.client.sCard(activeKey());
  }

  async markWorkflowActive(workflowId) {
    if (!this.ready) return;
    await this.client.sAdd(activeKey(), workflowId);
  }

  async markWorkflowInactive(workflowId) {
    if (!this.ready) return;
    await this.client.sRem(activeKey(), workflowId);
  }

  // Clear all active workflows
  async resetActiveWorkflows() {
    if (!this.ready) return;
    const stale = await this.client.sMembers(activeKey());
    if (stale.length > 0) {
      console.warn(`[ShortMemory] Clearing ${stale.length} stale active-workflow entry(ies) left over from a previous process life: ${stale.join(', ')}`);
    }
    await this.client.del(activeKey());
  }

  // Add an incident to a group
  async addToGroup(group, memberKey) {
    if (!this.ready) return;
    await this.client.sAdd(groupKey(group), memberKey);
  }

  async getGroupMembers(group) {
    if (!this.ready) return [];
    return this.client.sMembers(groupKey(group));
  }

  async clearGroup(group) {
    if (!this.ready) return;
    await this.client.del(groupKey(group));
  }

  // Pin a dispatch key for an incident
  async pinDispatchKey(resourceKey, dispatchKey, ttlMs) {
    if (!this.ready) return;
    await this.client.set(pinKey(resourceKey), dispatchKey, { PX: ttlMs });
  }

  async getPinnedDispatchKey(resourceKey) {
    if (!this.ready) return null;
    return this.client.get(pinKey(resourceKey));
  }

  async clearPin(resourceKey) {
    if (!this.ready) return;
    await this.client.del(pinKey(resourceKey));
  }

  // Scan Redis keys matching a pattern
  async _scanKeys(pattern) {
    const keys = [];
    for await (const batch of this.client.scanIterator({ MATCH: pattern, COUNT: 200 })) keys.push(...batch);
    return keys;
  }

  async dumpState() {
    if (!this.ready) return { ready: false };
    try {
      const [incidentKeys, lockKeys, attemptKeys, cooldownKeys, groupKeys, pinKeys, queueEntries, activeWorkflows] = await Promise.all([
        this._scanKeys('sm:incident:*'),
        this._scanKeys('sm:lock:*'),
        this._scanKeys('sm:attempts:*'),
        this._scanKeys('sm:cooldown:*'),
        this._scanKeys('sm:group:*'),
        this._scanKeys('sm:pin:*'),
        this.client.zRangeWithScores(queueKey(), 0, -1, { REV: true }),
        this.client.sMembers(activeKey()),
      ]);

      const incidents = await Promise.all(incidentKeys.map(async key => {
        const [raw, ttlSec] = await Promise.all([this.client.get(key), this.client.ttl(key)]);
        return { key: key.slice('sm:incident:'.length), ttlSec, incident: raw ? JSON.parse(raw) : null };
      }));
      const locks = await Promise.all(lockKeys.map(async key => {
        const [workflowId, ttlMs] = await Promise.all([this.client.get(key), this.client.pTTL(key)]);
        return { key: key.slice('sm:lock:'.length), workflowId, ttlMs };
      }));
      const attempts = await Promise.all(attemptKeys.map(async key => {
        const [raw, ttlSec] = await Promise.all([this.client.get(key), this.client.ttl(key)]);
        return { key: key.slice('sm:attempts:'.length), count: raw ? parseInt(raw, 10) : 0, ttlSec };
      }));
      const cooldowns = await Promise.all(cooldownKeys.map(async key => {
        const ttlMs = await this.client.pTTL(key);
        return { key: key.slice('sm:cooldown:'.length), ttlMs };
      }));
      const groups = await Promise.all(groupKeys.map(async key => {
        const members = await this.client.sMembers(key);
        return { dispatchKey: key.slice('sm:group:'.length), members };
      }));
      const pins = await Promise.all(pinKeys.map(async key => {
        const [dispatchKey, ttlMs] = await Promise.all([this.client.get(key), this.client.pTTL(key)]);
        return { resourceKey: key.slice('sm:pin:'.length), dispatchKey, ttlMs };
      }));

      return {
        ready: true,
        queue: queueEntries.map(e => ({ dispatchKey: e.value, priority: e.score })),
        activeWorkflows,
        incidents,
        locks,
        attempts,
        cooldowns,
        groups,
        pins,
      };
    } catch (err) {
      console.error('[ShortMemory] dumpState() failed:', err.message);
      return { ready: true, error: err.message, queue: [], activeWorkflows: [], incidents: [], locks: [], attempts: [], cooldowns: [], groups: [] };
    }
  }
}

module.exports = new ShortMemory();

