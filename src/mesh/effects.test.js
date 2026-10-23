import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createClient } = require('redis');
const { Bus } = require('./bus.js');
const effects = require('./effects.js');
const { startEffectsConsumer } = require('./effectsConsumer.js');
const tokenStore = require('../api/tokenStore.js');

const URL = process.env.MESH_TEST_REDIS_URL ?? 'redis://localhost:6379/15';
const quiet = { log() {}, warn() {}, error() {} };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function redisReachable() {
  const c = createClient({ url: URL, socket: { connectTimeout: 1000, reconnectStrategy: false } });
  c.on('error', () => {});
  try { await c.connect(); await c.ping(); await c.destroy(); return true; }
  catch { return false; }
}
const up = await redisReachable();

describe('effects outside a mesh handler', () => {
  it('emit() returns false so the store writes locally as before', () => {
    expect(effects.emit('tokens', { agent: 'planner', usage: {} })).toBe(false);
    expect(effects.currentTask()).toBeNull();
  });

  it('tokenStore.record still updates the in-process counters', () => {
    const before = tokenStore.getAll().agents.planner.calls;
    tokenStore.record('planner', { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
    expect(tokenStore.getAll().agents.planner.calls).toBe(before + 1);
  });
});

describe.skipIf(!up)('effects across the bus (real Redis)', () => {
  const buses = [];
  afterAll(async () => { await Promise.allSettled(buses.map(b => b.close({ drain: false }))); });

  it('ships store writes made inside a handler and applies them on the orchestrator side', async () => {
    const agentBus = await new Bus({ url: URL, serviceName: 'agent', logger: quiet, blockMs: 100 }).connect();
    const orchBus  = await new Bus({ url: URL, serviceName: 'orch',  logger: quiet, blockMs: 100 }).connect();
    buses.push(agentBus, orchBus);

    const taskId = randomUUID();
    const applied = [];
    await startEffectsConsumer(orchBus, {
      blockMs: 100,
      appliers: {
        tokens:   (data, e) => { if (e.taskId === taskId) applied.push(['tokens', data]); },
        incident: (data, e) => { if (e.taskId === taskId) applied.push(['incident', data]); },
      },
    });

    const before = tokenStore.getAll().agents.investigator.calls;
    await effects.runWithEffects({ bus: agentBus, taskId, workflowId: 'wf-1' }, async () => {
      expect(effects.currentTask()).toMatchObject({ taskId, workflowId: 'wf-1' });
      tokenStore.record('investigator', { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
      const shortMemory = require('../memory/shortMemory.js');
      await shortMemory.upsertIncident('ns/pod', { stage: 'investigating' });
    });

    for (let i = 0; i < 50 && applied.length < 2; i++) await sleep(50);

    expect(applied).toEqual([
      ['tokens', { agent: 'investigator', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }],
      ['incident', { key: 'ns/pod', incident: { stage: 'investigating' } }],
    ]);
    // Shipped, not written locally — the agent process's own counters didn't move.
    expect(tokenStore.getAll().agents.investigator.calls).toBe(before);
  });
});
