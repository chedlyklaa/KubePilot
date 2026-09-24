import { describe, it, expect, beforeAll } from 'vitest';

// planner.js transitively requires ../config (OPENAI_API_KEY/OPENAI_MODEL) and constructs
// a ChatOpenAI client at module load — same pattern as graph.test.js/investigator.test.js.
process.env.OPENAI_API_KEY ??= 'test-only-key';
process.env.OPENAI_MODEL   ??= 'test-model';

let planner, _lowConfidencePlan, _isConfidenceTooLowToPlan, LOW_CONFIDENCE_THRESHOLD, _cpuToMillicores, _memToMi;

beforeAll(async () => {
  ({ default: planner, _lowConfidencePlan, _isConfidenceTooLowToPlan, LOW_CONFIDENCE_THRESHOLD, _cpuToMillicores, _memToMi } =
    await import('./planner.js'));
});

describe('_isConfidenceTooLowToPlan (§Fix-PlannerConfidenceGate)', () => {
  // Match case — confirmed live: the Investigator's own fallback shape reports
  // confidence: 0 with rootCause "investigation unavailable, unable to determine
  // specific root cause". The Planner used to propose a confident-looking action anyway.
  it('is true at confidence 0 (investigation unavailable)', () => {
    expect(_isConfidenceTooLowToPlan(0)).toBe(true);
  });

  it('is true just under the threshold', () => {
    expect(_isConfidenceTooLowToPlan(LOW_CONFIDENCE_THRESHOLD - 0.01)).toBe(true);
  });

  it('treats a missing/undefined confidence the same as 0 (too low)', () => {
    expect(_isConfidenceTooLowToPlan(undefined)).toBe(true);
  });

  // Control case — a genuine high-confidence diagnosis (every real successful
  // investigation observed in test runs reports 0.9-0.95) must NOT be gated, or the
  // Planner would never be allowed to propose anything.
  it('control case: is false at a real investigation confidence (0.95)', () => {
    expect(_isConfidenceTooLowToPlan(0.95)).toBe(false);
  });

  it('control case: is false exactly at the threshold (0.5 is not "too low")', () => {
    expect(_isConfidenceTooLowToPlan(LOW_CONFIDENCE_THRESHOLD)).toBe(false);
  });
});

describe('_lowConfidencePlan', () => {
  const issues = [
    { clusterName: 'cluster2', namespace: 'shop', podName: 'billing-cluster2-3z9', deployment: 'billing', nodeName: null },
  ];

  it('produces a command-less step so it routes to escalation, not a guessed fix', () => {
    const plan = _lowConfidencePlan(issues, 0);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].command).toBe('');
    expect(plan.steps[0].reason).toMatch(/confidence/i);
  });

  // Regression test — found live 2026-09-04: a scope:"cluster" issue (or any issue
  // genuinely missing nodeName/deployment/podName) produced target.name: null, which
  // fails PlanStepSchema validation and crashes the whole workflow before it ever
  // reaches escalation. PlanSchema.parse() inside _lowConfidencePlan throws synchronously
  // if this regresses, so simply not throwing is the assertion that matters here.
  it('never produces a null target.name, even for an issue with no identifying field at all', () => {
    const namelessIssues = [
      { clusterName: 'staging-cluster', namespace: null, podName: null, deployment: null, nodeName: null },
    ];
    const plan = _lowConfidencePlan(namelessIssues, 0);
    expect(plan.steps).toHaveLength(1);
    expect(typeof plan.steps[0].target.name).toBe('string');
    expect(plan.steps[0].target.name.length).toBeGreaterThan(0);
  });
});

describe('_cpuToMillicores / _memToMi (§Fix-CapacityEvidence)', () => {
  it('parses millicore strings', () => {
    expect(_cpuToMillicores('500m')).toBe(500);
    expect(_cpuToMillicores('50m')).toBe(50);
  });

  it('parses bare-core strings as whole cores', () => {
    expect(_cpuToMillicores('2')).toBe(2000);
    expect(_cpuToMillicores('0.5')).toBe(500);
  });

  it('treats a missing quantity as zero rather than throwing', () => {
    expect(_cpuToMillicores(null)).toBe(0);
    expect(_cpuToMillicores(undefined)).toBe(0);
  });

  it('parses binary memory suffixes (Ki/Mi/Gi)', () => {
    expect(_memToMi('256Mi')).toBe(256);
    expect(_memToMi('1Gi')).toBe(1024);
    expect(_memToMi('1024Ki')).toBe(1);
  });

  it('parses decimal memory suffixes (M/G) distinctly from binary ones', () => {
    // 1 decimal GB = 1000^3 bytes = 1000^3 / (1024*1024) MiB ≈ 953.67 MiB, not 1024.
    expect(_memToMi('1G')).toBeCloseTo(953.674, 2);
  });

  it('treats a missing quantity as zero rather than throwing', () => {
    expect(_memToMi(null)).toBe(0);
    expect(_memToMi(undefined)).toBe(0);
  });
});

describe('Planner.plan — end-to-end gate wiring', () => {
  // No LLM mocking needed here: at confidence 0 the gate returns before
  // _runPlanningLoop() ever runs, so this exercises the real Planner.plan() entry point
  // without a network call — this is the exact "investigation unavailable" shape
  // confirmed live across many CrashLoopBackOff cycles in test-output/20-incidents/.
  it('returns a command-less plan without calling the LLM when confidence is 0', async () => {
    const issues = [
      { type: 'CrashLoopBackOff', clusterName: 'minikube', namespace: 'shop', podName: 'api-minikube-7f8', deployment: 'api', nodeName: null },
    ];
    const rca = { rootCause: 'CrashLoopBackOff — investigation unavailable, unable to determine specific root cause', confidence: 0 };
    const plan = await planner.plan(issues, rca, {});
    expect(plan.steps.every(s => s.command === '')).toBe(true);
  });
});
