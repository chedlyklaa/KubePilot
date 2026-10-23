import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// Point LangSmith at a dead local port so the background run uploads go nowhere — this
// test only checks context propagation, never that anything reached LangSmith.
const ENV = {
  LANGSMITH_TRACING: 'true',
  LANGSMITH_API_KEY: 'test-only',
  LANGSMITH_ENDPOINT: 'http://127.0.0.1:9',
  LANGCHAIN_ENDPOINT: 'http://127.0.0.1:9',
};
const saved = {};
function enableTracing() {
  for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
}
afterEach(() => {
  for (const k of Object.keys(ENV)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const { tracedRequest, tracedHandler } = require('./tracing.js');
const { traceable } = require('langsmith/traceable');
const { getCurrentRunTree } = require('langsmith/singletons/traceable');

describe('mesh tracing propagation', () => {
  it('is inert when tracing is off', async () => {
    delete process.env.LANGSMITH_TRACING;
    const prev = process.env.LANGCHAIN_TRACING_V2;
    process.env.LANGCHAIN_TRACING_V2 = 'false';
    try {
      await expect(tracedRequest('x.y', {}, headers => headers)).resolves.toBeUndefined();
      await expect(tracedHandler({ traceHeaders: { 'langsmith-trace': 'whatever' } }, 'svc', () => 'ran')).resolves.toBe('ran');
    } finally {
      if (prev === undefined) delete process.env.LANGCHAIN_TRACING_V2; else process.env.LANGCHAIN_TRACING_V2 = prev;
    }
  });

  it('continues the caller\'s trace inside the service handler', async () => {
    enableTracing();
    let callerTraceId, headers, serviceRun;

    // Caller: some traced orchestrator code (like the fleet-cycle root) makes a mesh call.
    await traceable(async () => {
      callerTraceId = getCurrentRunTree().trace_id;
      headers = await tracedRequest('investigator.investigate', { taskId: 't1' }, h => h);
    }, { name: 'fleet-cycle' })();

    expect(headers?.['langsmith-trace']).toBeTruthy();

    // Service: a different process would only have the envelope's headers.
    const env = { capability: 'investigator.investigate', traceHeaders: headers, task: { id: 't1', workflowId: 'wf' } };
    const out = await tracedHandler(env, 'investigator-svc', async () => {
      serviceRun = getCurrentRunTree(true);
      return 'report';
    });

    expect(out).toBe('report');
    expect(serviceRun?.trace_id).toBe(callerTraceId);              // same trace tree
    expect(serviceRun?.name).toBe('investigator-svc investigator.investigate');
  });

  it('runs the handler untraced when the envelope carries no headers', async () => {
    enableTracing();
    let run;
    const out = await tracedHandler({ capability: 'x.y', task: { id: 't' } }, 'svc', async () => { run = getCurrentRunTree(true); return 1; });
    expect(out).toBe(1);
    expect(run).toBeUndefined();
  });
});
