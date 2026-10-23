import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import { createRequire } from 'module';

// Integration tests against a REAL Redis — the guarantees under test (lease renewal,
// reclaim, consumer-group delivery counts) are Redis Streams semantics a fake can't
// reproduce faithfully. Uses DB 15 so it never touches the app's sm:* keys on DB 0, and
// skips cleanly when no Redis is reachable (CI without a Redis service).
const require = createRequire(import.meta.url);
const { createClient } = require('redis');
const { Bus, MeshError } = require('./bus.js');
const { RefuseError } = require('./envelope.js');

const URL = process.env.MESH_TEST_REDIS_URL ?? 'redis://localhost:6379/15';
const LEASE_MS = 300;

async function redisReachable() {
  const c = createClient({ url: URL, socket: { connectTimeout: 1000, reconnectStrategy: false } });
  c.on('error', () => {});
  try { await c.connect(); await c.ping(); await c.destroy(); return true; }
  catch { return false; }
}
const up = await redisReachable();

const quiet = { log() {}, warn() {}, error() {} };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const buses = [];
async function bus(name, opts = {}) {
  const b = await new Bus({ url: URL, serviceName: name, leaseMs: LEASE_MS, blockMs: 100, logger: quiet, ...opts }).connect();
  buses.push(b);
  return b;
}
const cap = () => `test-${randomUUID().slice(0, 8)}.run`;

afterEach(async () => {
  await Promise.allSettled(buses.splice(0).map(b => b.close({ drain: false })));
});

describe.skipIf(!up)('mesh bus (real Redis)', () => {
  it('round-trips a request to an inform reply', async () => {
    const c = cap();
    const worker = await bus('worker');
    await worker.serve(c, async input => ({ doubled: input.n * 2 }));
    const client = await bus('client');
    await expect(client.request(c, { n: 21 }, { timeoutMs: 5000 })).resolves.toEqual({ doubled: 42 });
  });

  it('maps RefuseError to refuse and other throws to failure', async () => {
    const c = cap();
    const worker = await bus('worker');
    await worker.serve(c, async input => {
      if (input.mode === 'refuse') throw new RefuseError('unknown cluster');
      throw new Error('boom');
    });
    const client = await bus('client');
    await expect(client.request(c, { mode: 'refuse' }, { timeoutMs: 5000 }))
      .rejects.toMatchObject({ performative: 'refuse', message: expect.stringContaining('unknown cluster') });
    await expect(client.request(c, { mode: 'fail' }, { timeoutMs: 5000 }))
      .rejects.toMatchObject({ performative: 'failure', message: expect.stringContaining('boom') });
  });

  it('never reclaims a slow-but-alive task (lease renewal)', async () => {
    const c = cap();
    let runs = 0;
    const handler = async () => { runs++; await sleep(LEASE_MS * 6); return 'done'; };
    const a = await bus('worker-a'); await a.serve(c, handler);
    const b = await bus('worker-b'); await b.serve(c, handler);
    const client = await bus('client');
    await expect(client.request(c, {}, { timeoutMs: 10_000 })).resolves.toBe('done');
    expect(runs).toBe(1);
  });

  it('reclaims a crashed worker\'s task on another replica', async () => {
    const c = cap();
    let startedOnA;
    const started = new Promise(r => { startedOnA = r; });
    const a = await bus('worker-a');
    await a.serve(c, () => { startedOnA(); return new Promise(() => {}); }); // hangs forever
    const client = await bus('client');
    const result = client.request(c, { x: 1 }, { timeoutMs: 10_000 });

    await started;
    await a.close({ drain: false }); // crash: no ack, no more lease renewals

    let runsOnB = 0;
    const b = await bus('worker-b');
    await b.serve(c, async input => { runsOnB++; return { recoveredWith: input.x }; });

    await expect(result).resolves.toEqual({ recoveredWith: 1 });
    expect(runsOnB).toBe(1);
  });

  it('runs a duplicate task id once and answers both callers', async () => {
    const c = cap();
    let runs = 0;
    const handler = async () => { runs++; await sleep(200); return `run-${runs}`; };
    const a = await bus('worker-a'); await a.serve(c, handler);
    const b = await bus('worker-b'); await b.serve(c, handler);
    const client = await bus('client');
    const taskId = randomUUID();
    const [r1, r2] = await Promise.all([
      client.request(c, {}, { taskId, timeoutMs: 5000 }),
      client.request(c, {}, { taskId, timeoutMs: 5000 }),
    ]);
    expect(runs).toBe(1);
    expect(r1).toBe('run-1');
    expect(r2).toBe('run-1');
  });

  it('replays a finished task id from the done cache instead of re-running it', async () => {
    const c = cap();
    let runs = 0;
    const worker = await bus('worker');
    await worker.serve(c, async () => ++runs);
    const client = await bus('client');
    const taskId = randomUUID();
    await expect(client.request(c, {}, { taskId, timeoutMs: 5000 })).resolves.toBe(1);
    await expect(client.request(c, {}, { taskId, timeoutMs: 5000 })).resolves.toBe(1);
    expect(runs).toBe(1);
  });

  it('dead-letters a task that exceeded maxDeliveries and fails the caller', async () => {
    const c = cap();
    let startedOnA;
    const started = new Promise(r => { startedOnA = r; });
    const a = await bus('worker-a');
    await a.serve(c, () => { startedOnA(); return new Promise(() => {}); });
    const client = await bus('client');
    const result = client.request(c, {}, { timeoutMs: 10_000 });
    await started;
    await a.close({ drain: false });

    const b = await bus('worker-b', { maxDeliveries: 1 });
    let runsOnB = 0;
    await b.serve(c, async () => { runsOnB++; });

    await expect(result).rejects.toMatchObject({ performative: 'failure', message: expect.stringContaining('mesh:dlq:') });
    expect(runsOnB).toBe(0);
    expect(await b.cmd.xLen(`mesh:dlq:${c}`)).toBe(1);
  });

  it('runs at most `concurrency` tasks at once per worker', async () => {
    const c = cap();
    let live = 0, peak = 0;
    const worker = await bus('worker');
    await worker.serve(c, async () => { live++; peak = Math.max(peak, live); await sleep(150); live--; return 'ok'; }, { concurrency: 2 });
    const client = await bus('client');
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => client.request(c, {}, { timeoutMs: 5000 })));
    expect(results).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    expect(peak).toBe(2);
  });

  it('refuses a task whose deadline passed before any worker picked it up', async () => {
    const c = cap();
    const client = await bus('client');
    const result = client.request(c, {}, { timeoutMs: 50 });
    await sleep(150);
    const worker = await bus('worker');
    let runs = 0;
    await worker.serve(c, async () => { runs++; });
    await expect(result).rejects.toMatchObject({ performative: 'refuse' });
    expect(runs).toBe(0);
  });

  it('aborts the handler signal at the task deadline', async () => {
    const c = cap();
    const worker = await bus('worker');
    await worker.serve(c, (_input, { signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason));
    }));
    const client = await bus('client');
    await expect(client.request(c, {}, { timeoutMs: 200 }))
      .rejects.toMatchObject({ performative: 'failure', message: expect.stringContaining('deadline') });
  });

  it('reports hop latency to the handler', async () => {
    const c = cap();
    let hop;
    const worker = await bus('worker');
    await worker.serve(c, async (_input, ctx) => { hop = ctx.hopMs; return true; });
    const client = await bus('client');
    await client.request(c, {}, { timeoutMs: 5000 });
    expect(hop).toBeGreaterThanOrEqual(0);
    expect(hop).toBeLessThan(1000);
  });

  it('rejects pending requests with a MeshError when the client bus closes', async () => {
    const client = await bus('client');
    const p = client.request(cap(), {}, { timeoutMs: 5000 });
    await sleep(20);
    await client.close({ drain: false });
    await expect(p).rejects.toBeInstanceOf(MeshError);
  });
});
