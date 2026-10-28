import { describe, it, expect, beforeAll } from 'vitest';

process.env.OPENAI_API_KEY ??= 'test-only-key';
process.env.OPENAI_MODEL   ??= 'test-model';

let planner, _lowConfidencePlan, _isConfidenceTooLowToPlan, LOW_CONFIDENCE_THRESHOLD, _cpuToMillicores, _memToMi, _slimInvestigation;

beforeAll(async () => {
  ({ default: planner, _lowConfidencePlan, _isConfidenceTooLowToPlan, LOW_CONFIDENCE_THRESHOLD, _cpuToMillicores, _memToMi, _slimInvestigation } =
    await import('./planner.js'));
});

describe('_isConfidenceTooLowToPlan (§Fix-PlannerConfidenceGate)', () => {
  it('is true at confidence 0 (investigation unavailable)', () => {
    expect(_isConfidenceTooLowToPlan(0)).toBe(true);
  });

  it('is true just under the threshold', () => {
    expect(_isConfidenceTooLowToPlan(LOW_CONFIDENCE_THRESHOLD - 0.01)).toBe(true);
  });

  it('treats a missing/undefined confidence the same as 0 (too low)', () => {
    expect(_isConfidenceTooLowToPlan(undefined)).toBe(true);
  });

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
    expect(_memToMi('1G')).toBeCloseTo(953.674, 2);
  });

  it('treats a missing quantity as zero rather than throwing', () => {
    expect(_memToMi(null)).toBe(0);
    expect(_memToMi(undefined)).toBe(0);
  });
});

describe('Planner.plan — end-to-end gate wiring', () => {
  it('returns a command-less plan without calling the LLM when confidence is 0', async () => {
    const issues = [
      { type: 'CrashLoopBackOff', clusterName: 'minikube', namespace: 'shop', podName: 'api-minikube-7f8', deployment: 'api', nodeName: null },
    ];
    const rca = { rootCause: 'CrashLoopBackOff — investigation unavailable, unable to determine specific root cause', confidence: 0 };
    const plan = await planner.plan(issues, rca, {});
    expect(plan.steps.every(s => s.command === '')).toBe(true);
  });
});

describe('_slimInvestigation — the Planner gets what it plans from, not the audit trail', () => {
  const rca = {
    rootCause: 'bad image tag', layer: 'image', symptom: 'ImagePullBackOff', severity: 'high', riskLevel: 'medium',
    confidence: 0.9, evidenceSufficiency: 0.9, reachedConfidenceTarget: true, componentsInvolved: ['web'],
    evidence: ['Failed to pull image "web:1.9.9": not found'], recommendedFocus: 'roll back the image',
    perLayerFindings: [
      { layer: 'image', status: 'critical', summary: 'tag missing', commandsRun: ['describe pod web'] },
      { layer: 'node',  status: 'healthy',  summary: 'fine',        commandsRun: ['top nodes'] },
      { layer: 'network', status: 'warning', summary: 'slow DNS',   commandsRun: [] },
    ],
    commandsExecuted: [{ command: 'describe pod web', reasoning: 'r', result: 'z'.repeat(500) }],
    suspected_cause: 'bad image tag', recommended_focus: 'roll back', risk_level: 'medium',
    stoppingOutcome: 'DIAGNOSIS_READY', investigationTurns: 6,
  };

  it('keeps diagnosis fields and only critical/warning findings', () => {
    const slim = _slimInvestigation(rca);
    expect(slim.rootCause).toBe('bad image tag');
    expect(slim.evidence).toEqual(rca.evidence);
    expect(slim.confidence).toBe(0.9);
    expect(slim.findings).toEqual([
      { layer: 'image', status: 'critical', summary: 'tag missing' },
      { layer: 'network', status: 'warning', summary: 'slow DNS' },
    ]);
  });

  it('drops the command audit trail, legacy duplicates and dashboard metrics', () => {
    const slim = _slimInvestigation(rca);
    for (const k of ['commandsExecuted', 'suspected_cause', 'recommended_focus', 'risk_level', 'stoppingOutcome', 'investigationTurns', 'perLayerFindings']) {
      expect(slim).not.toHaveProperty(k);
    }
    expect(JSON.stringify(slim).length).toBeLessThan(JSON.stringify(rca).length / 2);
  });

  it('passes a missing report through unchanged', () => {
    expect(_slimInvestigation(null)).toBeNull();
  });
});
