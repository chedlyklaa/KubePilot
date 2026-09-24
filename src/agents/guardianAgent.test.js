import { describe, it, expect, beforeAll } from 'vitest';

// guardianAgent.js pulls in ../config (OPENAI_API_KEY/OPENAI_MODEL) transitively at
// module load — same pattern as graph.test.js/investigator.test.js/planner.test.js.
process.env.OPENAI_API_KEY ??= 'test-only-key';
process.env.OPENAI_MODEL   ??= 'test-model';

let GuardianAgent, _guardianFailureVerdict;

beforeAll(async () => {
  ({ default: GuardianAgent, _guardianFailureVerdict } = await import('./guardianAgent.js'));
});

// §Fix-GuardianFailClosed (2026-09-18) — every Guardian failure path used to return an
// APPROVE-shaped fallback ("proceeding with caution"). Real end-to-end coverage of each
// failure path (LLM throws, malformed JSON, invalid verdict string, MODIFY with no
// suggestedCommand) driven through the real GuardianAgent.review() lives in
// scripts/verify-guardian-failclosed.js, not here — this repo's Vitest can't reliably
// mock nested require() between plain CJS files (llmCircuitBreaker.runLLMCall must be
// monkey-patched BEFORE guardianAgent.js's own top-level `require()` destructures it,
// which needs a fresh process, not vi.mock — see that script's header for the pattern
// this mirrors from scripts/test-fastpath-live.js). What IS safely unit-testable here,
// with zero LLM/network involvement, is the shape of the fallback object itself.
describe('_guardianFailureVerdict — fail-closed shape', () => {
  it('never returns APPROVE', () => {
    const v = _guardianFailureVerdict('some failure reason');
    expect(v.verdict).not.toBe('APPROVE');
  });

  it('returns DELEGATE_HUMAN with classification DANGEROUS and confidence 0', () => {
    const v = _guardianFailureVerdict('Guardian was unavailable (timeout) — escalated to a human rather than auto-approved.');
    expect(v.verdict).toBe('DELEGATE_HUMAN');
    expect(v.classification).toBe('DANGEROUS');
    expect(v.confidence).toBe(0);
    expect(v.suggestedCommand).toBeNull();
  });

  it('carries the caller-supplied reason through verbatim', () => {
    const v = _guardianFailureVerdict('unparseable JSON response');
    expect(v.reason).toBe('unparseable JSON response');
  });

  it('flags safetyConcerns so the escalation record is self-explanatory, not just a bare DELEGATE_HUMAN', () => {
    const v = _guardianFailureVerdict('x');
    expect(v.safetyConcerns.length).toBeGreaterThan(0);
  });
});

describe('GuardianAgent module shape', () => {
  it('is constructible with a cluster name and tier', () => {
    const g = new GuardianAgent('test-cluster', 'dev');
    expect(g.clusterName).toBe('test-cluster');
    expect(g.tier).toBe('dev');
  });
});
