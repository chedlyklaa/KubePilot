import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { StateGraph, Annotation, START, END } from '@langchain/langgraph';

let tokenStore;

beforeAll(async () => {
  ({ default: tokenStore } = await import('./tokenStore.js'));
});

beforeEach(() => tokenStore.reset());

const u = (prompt, completion = 10, cached = 0) =>
  ({ prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, cached_tokens: cached });

describe('usageFrom', () => {
  it('reads a LangChain AIMessage usage_metadata, including cache reads', () => {
    expect(tokenStore.usageFrom({ usage_metadata: { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_token_details: { cache_read: 60 } } }))
      .toEqual({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cached_tokens: 60 });
  });

  it('reads the older response_metadata.tokenUsage shape', () => {
    expect(tokenStore.usageFrom({ response_metadata: { tokenUsage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 } } }))
      .toEqual({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7, cached_tokens: 0 });
  });

  it('reads a raw OpenAI-SDK usage object with nested cached_tokens', () => {
    expect(tokenStore.usageFrom({ prompt_tokens: 50, completion_tokens: 5, total_tokens: 55, prompt_tokens_details: { cached_tokens: 30 } }).cached_tokens).toBe(30);
  });

  it('returns null when there is no usage', () => {
    expect(tokenStore.usageFrom({ content: 'hi' })).toBeNull();
    expect(tokenStore.usageFrom(undefined)).toBeNull();
  });
});

describe('record / getAll', () => {
  it('counts the newly tracked agents and ignores unknown names', () => {
    tokenStore.record('fastPath', u(100));
    tokenStore.record('rootCauseFit', u(40));
    tokenStore.record('chat', u(10));
    tokenStore.record('not-an-agent', u(999));
    const { agents, total } = tokenStore.getAll();
    expect(agents.fastPath.prompt).toBe(100);
    expect(agents.rootCauseFit.calls).toBe(1);
    expect(agents.chat.prompt).toBe(10);
    expect(total.prompt).toBe(150);
  });

  it('counts cached tokens from raw OpenAI usage passed straight through (Guardian/Reflection)', () => {
    tokenStore.record('guardian', { prompt_tokens: 80, completion_tokens: 5, total_tokens: 85, prompt_tokens_details: { cached_tokens: 64 } });
    expect(tokenStore.getAll().agents.guardian.cached).toBe(64);
  });
});

describe('withScope', () => {
  it('collects only the calls made inside the scope, on top of the global counters', async () => {
    tokenStore.record('planner', u(1000));
    const { result, usage } = await tokenStore.withScope(async () => {
      tokenStore.record('investigator', u(300, 20, 100));
      await new Promise(r => setTimeout(r, 5));
      tokenStore.record('planner', u(200));
      return 'done';
    });
    expect(result).toBe('done');
    expect(usage.agents.investigator).toMatchObject({ prompt: 300, cached: 100, calls: 1 });
    expect(usage.agents.planner.prompt).toBe(200);
    expect(usage.total.prompt).toBe(500);
    expect(tokenStore.getAll().agents.planner.prompt).toBe(1200);
  });

  it('keeps concurrent LangGraph workflows apart', async () => {
    const State = Annotation.Root({ n: Annotation({ default: () => 0 }) });
    const graph = new StateGraph(State)
      .addNode('a', async s => { await new Promise(r => setTimeout(r, 5)); tokenStore.record('investigator', u(s.n)); return {}; })
      .addNode('b', async s => { tokenStore.record('planner', u(s.n * 2)); return {}; })
      .addEdge(START, 'a').addEdge('a', 'b').addEdge('b', END)
      .compile();

    const [w1, w2] = await Promise.all([
      tokenStore.withScope(() => graph.invoke({ n: 100 })),
      tokenStore.withScope(() => graph.invoke({ n: 7 })),
    ]);
    expect(w1.usage.total.prompt).toBe(300);
    expect(w2.usage.total.prompt).toBe(21);
    expect(w1.usage.agents.planner.prompt).toBe(200);
  });
});

describe('unwrapStructured', () => {
  it('records the raw message usage and returns the parsed value', () => {
    const parsed = tokenStore.unwrapStructured('fastPath', { raw: { usage_metadata: { input_tokens: 42, output_tokens: 3, total_tokens: 45 } }, parsed: { ok: true } });
    expect(parsed).toEqual({ ok: true });
    expect(tokenStore.getAll().agents.fastPath.prompt).toBe(42);
  });

  it('still records usage, then throws, when parsing failed (includeRaw returns parsed: null)', () => {
    expect(() => tokenStore.unwrapStructured('rootCauseFit', { raw: { usage_metadata: { input_tokens: 9, output_tokens: 1, total_tokens: 10 } }, parsed: null }))
      .toThrow(/did not match/);
    expect(tokenStore.getAll().agents.rootCauseFit.prompt).toBe(9);
  });
});
