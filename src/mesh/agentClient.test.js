import { describe, it, expect, afterAll } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createClient } = require('redis');

const URL = process.env.MESH_TEST_REDIS_URL ?? 'redis://localhost:6379/15';
process.env.MESH_REDIS_URL = URL;

const { agentClient, agentMode, modeEnvVar } = require('./agentClient.js');
const { Bus } = require('./bus.js');
const { closeBus } = require('./busSingleton.js');

async function redisReachable() {
  const c = createClient({ url: URL, socket: { connectTimeout: 1000, reconnectStrategy: false } });
  c.on('error', () => {});
  try { await c.connect(); await c.ping(); await c.destroy(); return true; }
  catch { return false; }
}
const up = await redisReachable();

describe('agentClient', () => {
  it('derives the mode env var from the agent name', () => {
    expect(modeEnvVar('k8s-write')).toBe('AGENT_K8S_WRITE_MODE');
    expect(modeEnvVar('investigator')).toBe('AGENT_INVESTIGATOR_MODE');
  });

  it('defaults to local and only loads the local adapter on first call', async () => {
    let loads = 0;
    const client = agentClient('unit-local', ['echo'], () => { loads++; return { echo: input => ({ got: input }) }; });
    expect(client.mode).toBe('local');
    expect(loads).toBe(0);
    await expect(client.echo({ a: 1 })).resolves.toEqual({ got: { a: 1 } });
    await client.echo({ a: 2 });
    expect(loads).toBe(1);
  });

  it('treats anything other than "remote" as local', () => {
    process.env.AGENT_UNIT_ODD_MODE = 'REMOTE';
    expect(agentMode('unit-odd')).toBe('local');
    delete process.env.AGENT_UNIT_ODD_MODE;
  });
});

describe.skipIf(!up)('agentClient remote mode (real Redis)', () => {
  let worker;
  afterAll(async () => {
    delete process.env.AGENT_UNIT_REMOTE_MODE;
    await worker?.close({ drain: false });
    await closeBus({ drain: false });
  });

  it('routes calls to "<agent>.<method>" over the bus without loading the local adapter', async () => {
    worker = await new Bus({ url: URL, serviceName: 'unit-remote-svc', blockMs: 100, logger: { log() {}, warn() {}, error() {} } }).connect();
    await worker.serve('unit-remote.echo', async (input, ctx) => ({ got: input, workflowId: ctx.env.task.workflowId }));

    process.env.AGENT_UNIT_REMOTE_MODE = 'remote';
    let loads = 0;
    const client = agentClient('unit-remote', ['echo'], () => { loads++; return {}; });
    expect(client.mode).toBe('remote');

    await expect(client.echo({ x: 1 }, { workflowId: 'wf-9', timeoutMs: 5000 }))
      .resolves.toEqual({ got: { x: 1 }, workflowId: 'wf-9' });
    expect(loads).toBe(0);
  });
});
