import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

process.env.OPENAI_API_KEY      ??= 'test-only-key';
process.env.OPENAI_MODEL        ??= 'test-model';
process.env.NOTIFICATION_SECRET ??= 'test-only-secret-not-a-real-value-0123456789';

const { StateGraph, Annotation, START, END } = require('@langchain/langgraph');
const checkpointing = require('./checkpointing.js');

let _resumeDecision, EXECUTOR_REPLAY_WINDOW_MS;
beforeAll(async () => {
  ({ _resumeDecision, EXECUTOR_REPLAY_WINDOW_MS } = (await import('./graph.js')).default);
});

// ── Resume safety rules (pure) ─────────────────────────────────────────────

describe('_resumeDecision', () => {
  const snap = (next, createdAt = new Date().toISOString()) => ({ values: { workflowId: 'wf' }, next, createdAt });

  it('does not resume without a checkpoint', () => {
    expect(_resumeDecision(undefined, { k8sWriteMode: 'remote' }).resume).toBe(false);
    expect(_resumeDecision({ values: {}, next: ['planner'] }, { k8sWriteMode: 'remote' }).resume).toBe(false);
  });

  it('does not resume a workflow that already finished', () => {
    expect(_resumeDecision(snap([]), { k8sWriteMode: 'remote' })).toMatchObject({ resume: false, reason: expect.stringContaining('finished') });
  });

  it('resumes read-only/agent nodes in either k8s-write mode', () => {
    for (const node of ['investigator', 'planner', 'guardian', 'policy', 'reflexion']) {
      expect(_resumeDecision(snap([node]), { k8sWriteMode: 'local' })).toEqual({ resume: true, next: [node] });
    }
  });

  it('never re-runs the executor with in-process k8s-write (no idempotency cache)', () => {
    expect(_resumeDecision(snap(['executor']), { k8sWriteMode: 'local' }))
      .toMatchObject({ resume: false, reason: expect.stringContaining('not re-applying') });
  });

  it('re-runs the executor via the remote gateway only inside its replay window', () => {
    const now = Date.now();
    const fresh = new Date(now - 60_000).toISOString();
    const stale = new Date(now - EXECUTOR_REPLAY_WINDOW_MS - 60_000).toISOString();
    expect(_resumeDecision(snap(['executor'], fresh), { k8sWriteMode: 'remote', now }).resume).toBe(true);
    expect(_resumeDecision(snap(['executor'], stale), { k8sWriteMode: 'remote', now }))
      .toMatchObject({ resume: false, reason: expect.stringContaining('replay window') });
  });
});

// ── LangGraph + MongoDBSaver resume semantics (real MongoDB) ───────────────
// The resume feature rests on these behaviors; verify them against the real saver, on a
// throwaway database that's dropped afterwards.

const TEST_URI = process.env.CHECKPOINT_TEST_MONGO_URI ?? 'mongodb://localhost:27017/kubepilot_checkpoint_test';

async function mongoReachable() {
  try {
    const saver = await checkpointing.initCheckpointer({ uri: TEST_URI });
    return !!saver;
  } catch { return false; }
}
const up = await mongoReachable();

describe.skipIf(!up)('checkpointed resume (real MongoDB)', () => {
  afterAll(async () => {
    const saver = checkpointing.getCheckpointer();
    await saver?.db.dropDatabase().catch(() => {});
    await checkpointing.closeCheckpointer();
  });

  it('resumes an interrupted thread at the failed node without re-running completed ones', async () => {
    const saver = checkpointing.getCheckpointer();
    const runs = { a: 0, b: 0, c: 0 };
    let crashB = true;
    const State = Annotation.Root({
      workflowId: Annotation(),
      trail: Annotation({ reducer: (x, y) => x.concat(y), default: () => [] }),
    });
    const g = new StateGraph(State)
      .addNode('a', async () => { runs.a++; return { trail: ['a'] }; })
      .addNode('b', async () => {
        runs.b++;
        if (crashB) throw new Error('process died here');
        return { trail: ['b'] };
      })
      .addNode('c', async () => { runs.c++; return { trail: ['c'] }; })
      .addEdge(START, 'a').addEdge('a', 'b').addEdge('b', 'c').addEdge('c', END)
      .compile({ checkpointer: saver });

    const config = { configurable: { thread_id: `wf-${Date.now()}` } };
    await expect(g.invoke({ workflowId: 'wf-1', trail: [] }, config)).rejects.toThrow('process died here');

    const snapshot = await g.getState(config);
    expect(snapshot.next).toEqual(['b']);
    expect(snapshot.values.workflowId).toBe('wf-1');
    expect(Number.isNaN(new Date(snapshot.createdAt).getTime())).toBe(false);
    expect(_resumeDecision(snapshot, { k8sWriteMode: 'local' })).toEqual({ resume: true, next: ['b'] });

    crashB = false;
    const result = await g.invoke(null, config); // ← what resumeWorkflow does
    expect(result.trail).toEqual(['a', 'b', 'c']);
    expect(runs).toEqual({ a: 1, b: 2, c: 1 }); // 'a' NOT re-run; 'b' re-run from its start

    const done = await g.getState(config);
    expect(done.next).toEqual([]);
    expect(_resumeDecision(done, { k8sWriteMode: 'remote' }).resume).toBe(false);

    await saver.deleteThread(config.configurable.thread_id);
    expect((await g.getState(config)).values).toEqual({});
  });
});
