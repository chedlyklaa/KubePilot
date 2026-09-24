'use strict';
const { createClient } = require('redis');
const { loadConfig }   = require('../config');

// ── Short Memory ───────────────────────────────────────────────────────────
// Live incident state for the v5 Orchestrator: dedup, priority queue, per-resource
// locks, attempt counts, and cooldowns. Redis-backed replacement for the in-process
// `cooldowns`/`attemptCounts`/`_resourceLocks` Maps that used to live on ClusterAgent
// (clusterAgent.js:109-116) — state now survives a process restart instead of being
// lost, and is shared cluster-wide instead of pinned to one ClusterAgent instance.
//
// Mirrors the module shape of episodicMemory.js/vectorStore.js: a singleton with
// `initialize()` + a `ready` flag, degrading gracefully (never throwing) if Redis is
// unreachable at boot — matches FleetOrchestrator.start()'s existing
// "offline (semantic search disabled)" pattern.

const INCIDENT_TTL_SEC  = 24 * 60 * 60; // stale incident state expires after 24h
const DEFAULT_LOCK_TTL_MS = 5 * 60 * 1000; // 5 min — long enough for a full workflow run

function incidentKey(key)  { return `sm:incident:${key}`; }
function lockKey(key)      { return `sm:lock:${key}`; }
function attemptsKey(key)  { return `sm:attempts:${key}`; }
function cooldownKey(key)  { return `sm:cooldown:${key}`; }
// Fixed, fleet-wide — no longer per-cluster. Was `sm:queue:<cluster>`/`sm:active:<cluster>`
// back when one OrchestratorAgent instance owned exactly one cluster; now that dispatch
// itself can span clusters (a namespace-scoped dispatch key groups incidents from every
// cluster that has something in that namespace), "per cluster" concurrency has no
// coherent meaning to key on — ISSUE_CONCURRENCY is now a flat cap on total in-flight
// workflows across the whole fleet, not 3-per-cluster.
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

  // ── Incident state ────────────────────────────────────────────────────────

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

  // ── Per-resource lock — replaces `_resourceLocks` Map ───────────────────────
  // SET NX is atomic: only one caller ever gets `true` back for a given key.

  async acquireResourceLock(key, workflowId, ttlMs = DEFAULT_LOCK_TTL_MS) {
    if (!this.ready) return true; // fail-open: don't block remediation on Redis being down
    const result = await this.client.set(lockKey(key), workflowId, { NX: true, PX: ttlMs });
    return result === 'OK';
  }

  async releaseResourceLock(key) {
    if (!this.ready) return;
    await this.client.del(lockKey(key));
  }

  // ── Priority queue — replaces the plain `issueQueue` array ─────────────────
  // A Redis sorted set scored by priority (higher = more urgent). The incident
  // payload itself lives under upsertIncident(); the queue only tracks ordering.

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

  // ── Attempts + cooldown — same semantics as today's Maps, Redis-backed ─────

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

  // ── Active workflow tracking — enforces the 3-parallel-workflow cap ─────────

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

  // Clears the active-workflow set entirely — call once at process boot, before any
  // new workflow is dispatched. `sm:active:fleet` has no TTL and is only ever emptied by
  // the in-memory `.finally()` on a `runWorkflow()` promise (see orchestratorAgent.js);
  // if the process restarts (crash, nodemon reload) while a workflow is genuinely
  // in-flight, that promise and its cleanup are abandoned but the Redis entry survives,
  // permanently occupying one of the ISSUE_CONCURRENCY slots. A freshly-started process
  // cannot have any workflow actually in flight yet, so anything already in this set
  // necessarily predates this process life and is safe — and necessary — to discard.
  async resetActiveWorkflows() {
    if (!this.ready) return;
    const stale = await this.client.sMembers(activeKey());
    if (stale.length > 0) {
      console.warn(`[ShortMemory] Clearing ${stale.length} stale active-workflow entry(ies) left over from a previous process life: ${stale.join(', ')}`);
    }
    await this.client.del(activeKey());
  }

  // ── Group membership — namespace-grouped workflows ──────────────────────────
  // One dispatch key (a namespace, or a node — trivially a group of 1) can track
  // multiple pending resource keys, so a single workflow run can be launched for all
  // of them together instead of one workflow per resource. Individual resource state
  // (upsertIncident/cooldown/attempts) stays keyed per resource, untouched — only
  // dispatch grouping is new.

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

  // ── Correlation-tag pinning (§Fix-CorrelationTagDrift, 2026-09-22) ──────────
  // orchestratorAgent's classifier is a stateless, per-cycle LLM call — it has no
  // memory of what correlationTag string it used last cycle for a relationship
  // that's STILL sitting undispatched, so it reliably invents a different-but-
  // equivalent tag each cycle (confirmed live: 11 distinct
  // "ns:demo-fix-mk:corr:insufficient-cpu-*" queue entries for the SAME
  // undispatched incident within ~5 minutes — every cycle's fresh tag minted a
  // brand-new sorted-set entry instead of reinforcing the existing one, since
  // dispatchKey is built directly from the raw tag string). This lets a resource
  // "remember" which dispatchKey it was already grouped under, independent of
  // whatever wording the classifier happens to use this cycle — see
  // orchestratorAgent.js's _resolveDispatchKeys for how it's used. TTL-based
  // (not cleared on every read) so a resource that stops being reclassified
  // (fixed, or genuinely gone) naturally stops pinning to a stale key without
  // needing an explicit cleanup call on every possible exit path.

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

  // ── Debug dump — everything currently held in Redis, for the dashboard's Live
  // Pipeline page. Read-only, best-effort (never throws — a scan/get race against a
  // key expiring mid-dump just drops that one entry rather than failing the whole
  // dump), and uses SCAN (not KEYS) so a large keyspace doesn't block Redis for other
  // callers while this runs. Not meant for anything but eyeballing current state.
  async _scanKeys(pattern) {
    const keys = [];
    // scanIterator yields one BATCH (array of keys) per SCAN round-trip, not one key
    // per iteration (confirmed against @redis/client's source, node_modules/@redis/
    // client/dist/lib/client/index.js: `yield reply.keys`) — pushing the batch itself
    // instead of spreading it silently produced an array-of-arrays here, which then
    // failed downstream with a confusing low-level redis-client type error the moment
    // one of those "keys" was handed to get()/pTTL() as if it were a single key.
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

