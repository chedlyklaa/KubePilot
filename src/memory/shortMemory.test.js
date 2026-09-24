import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

// shortMemory.js pulls in ../config, whose EnvSchema requires OPENAI_API_KEY/
// OPENAI_MODEL/NOTIFICATION_SECRET to be set — same pattern as escalationStore.test.js:
// set them before the module graph loads, via a dynamic (non-hoisted) import.
process.env.OPENAI_API_KEY    ??= 'test-only-key';
process.env.OPENAI_MODEL      ??= 'test-model';
process.env.NOTIFICATION_SECRET ??= 'test-only-secret-not-a-real-value-0123456789';

// In-memory fake standing in for the `redis` client — exercises shortMemory.js's own
// key-construction/branching logic without requiring a real Redis server in CI.
function fakeRedisClient() {
  const store = new Map();
  const zsets = new Map();
  const sets  = new Map();
  return {
    on: () => {},
    connect: async () => {},
    async set(key, value, opts = {}) {
      if (opts.NX && store.has(key)) return null;
      store.set(key, String(value));
      return 'OK';
    },
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async del(...keys) {
      let n = 0;
      for (const k of keys.flat()) if (store.delete(k)) n++;
      return n;
    },
    async incr(key) {
      const n = (parseInt(store.get(key) ?? '0', 10)) + 1;
      store.set(key, String(n));
      return n;
    },
    async expire() { return 1; },
    async exists(key) { return store.has(key) ? 1 : 0; },
    async zAdd(key, entries) {
      if (!zsets.has(key)) zsets.set(key, new Map());
      const z = zsets.get(key);
      for (const { score, value } of entries) z.set(value, score);
      return entries.length;
    },
    async zRange(key, start, stop, opts = {}) {
      const z = zsets.get(key) ?? new Map();
      const arr = [...z.entries()].sort((a, b) => (opts.REV ? b[1] - a[1] : a[1] - b[1]));
      const end = stop === -1 ? arr.length : stop + 1;
      return arr.slice(start, end).map(([v]) => v);
    },
    async zRem(key, members) {
      const z = zsets.get(key);
      if (!z) return 0;
      let n = 0;
      for (const m of (Array.isArray(members) ? members : [members])) if (z.delete(m)) n++;
      return n;
    },
    async zCard(key) { return zsets.get(key)?.size ?? 0; },
    async sAdd(key, member) {
      if (!sets.has(key)) sets.set(key, new Set());
      sets.get(key).add(member);
      return 1;
    },
    async sRem(key, member) { return sets.get(key)?.delete(member) ? 1 : 0; },
    async sCard(key) { return sets.get(key)?.size ?? 0; },
  };
}

let shortMemory;
let fake;

beforeAll(async () => {
  ({ default: shortMemory } = await import('./shortMemory.js'));
});

// Inject the fake client directly rather than going through initialize() — avoids
// any real network attempt against a Redis server that may not exist in CI, and
// keeps this a pure test of shortMemory.js's own key-construction/branching logic.
beforeEach(() => {
  fake = fakeRedisClient();
  shortMemory.client = fake;
  shortMemory.ready  = true;
});

describe('ShortMemory — incident state', () => {
  it('round-trips an incident through upsert/get', async () => {
    await shortMemory.upsertIncident('default/api', { type: 'CrashLoopBackOff', severity: 'high' });
    const got = await shortMemory.getIncident('default/api');
    expect(got).toEqual({ type: 'CrashLoopBackOff', severity: 'high' });
  });

  it('resolveIncident clears incident, attempts, and cooldown for the key', async () => {
    await shortMemory.upsertIncident('default/api', { type: 'X' });
    await shortMemory.incrementAttempt('default/api');
    await shortMemory.setCooldown('default/api', 60_000);

    await shortMemory.resolveIncident('default/api');

    expect(await shortMemory.getIncident('default/api')).toBeNull();
    expect(await shortMemory.attemptCount('default/api')).toBe(0);
    expect(await shortMemory.cooldownActive('default/api')).toBe(false);
  });
});

describe('ShortMemory — per-resource lock', () => {
  it('only the first caller acquires the lock for a given key', async () => {
    const first  = await shortMemory.acquireResourceLock('default/api', 'wf-1');
    const second = await shortMemory.acquireResourceLock('default/api', 'wf-2');
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it('releasing the lock lets a new workflow acquire it', async () => {
    await shortMemory.acquireResourceLock('default/api', 'wf-1');
    await shortMemory.releaseResourceLock('default/api');
    const reacquired = await shortMemory.acquireResourceLock('default/api', 'wf-2');
    expect(reacquired).toBe(true);
  });
});

// Fleet-wide now, not per-cluster (queueKey()/activeKey() dropped their cluster
// parameter — see shortMemory.js) — one flat queue/active-set for the whole fleet,
// since a single dispatch key can itself span multiple clusters' incidents.
describe('ShortMemory — priority queue (fleet-wide)', () => {
  it('dequeues highest-priority incidents first', async () => {
    await shortMemory.enqueue('ns/low', 1);
    await shortMemory.enqueue('ns/critical', 4);
    await shortMemory.enqueue('ns/medium', 2);

    const top2 = await shortMemory.dequeue(2);
    expect(top2).toEqual(['ns/critical', 'ns/medium']);
  });

  it('dequeued keys are removed from the queue', async () => {
    await shortMemory.enqueue('ns/only', 3);
    await shortMemory.dequeue(5);
    expect(await shortMemory.queueDepth()).toBe(0);
  });
});

describe('ShortMemory — active workflow tracking (fleet-wide concurrency cap)', () => {
  it('counts active workflows and reflects mark/unmark', async () => {
    await shortMemory.markWorkflowActive('wf-1');
    await shortMemory.markWorkflowActive('wf-2');
    expect(await shortMemory.activeWorkflowCount()).toBe(2);

    await shortMemory.markWorkflowInactive('wf-1');
    expect(await shortMemory.activeWorkflowCount()).toBe(1);
  });
});

describe('ShortMemory — fail-open when Redis is unreachable', () => {
  it('acquireResourceLock returns true (never blocks remediation) when not ready', async () => {
    shortMemory.ready = false;
    const locked = await shortMemory.acquireResourceLock('default/api', 'wf-1');
    expect(locked).toBe(true);
  });
});
