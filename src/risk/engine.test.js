import { describe, it, expect } from 'vitest';
import RiskEngine from './engine.js';

const risk = new RiskEngine();

describe('RiskEngine.getActionRisk', () => {
  it.each([
    ['inspect', 0.05],
    ['get_logs', 0.05],
    ['restart_pod', 0.15],
    ['restart_deployment', 0.2],
    ['scale_small', 0.3],
    ['scale_large', 0.55],
    ['apply_manifest', 0.6],
    ['delete_pod', 0.65],
    ['scale_to_zero', 0.8],
    ['delete_resource', 0.9],
    ['modify_rbac', 0.92],
    ['cluster_upgrade', 0.95],
    ['delete_namespace', 0.98],
  ])('maps %s to a base risk of %s', (action, expected) => {
    expect(risk.getActionRisk(action)).toBe(expected);
  });

  it('defaults unknown actions to 0.5', () => {
    expect(risk.getActionRisk('totally_unknown_action')).toBe(0.5);
  });
});

describe('RiskEngine.getClusterTierMultiplier', () => {
  it.each([
    ['dev', 0.7],
    ['staging', 1.0],
    ['production', 1.3],
  ])('maps tier %s to multiplier %s', (tier, expected) => {
    expect(risk.getClusterTierMultiplier(tier)).toBe(expected);
  });

  it('defaults an unknown tier to 1 (no adjustment)', () => {
    expect(risk.getClusterTierMultiplier('nonexistent-tier')).toBe(1);
  });
});

describe('RiskEngine.getDecision (threshold boundaries)', () => {
  it('scores below 0.3 are AUTONOMOUS', () => {
    expect(risk.getDecision(0)).toBe('AUTONOMOUS');
    expect(risk.getDecision(0.29)).toBe('AUTONOMOUS');
  });
  it('scores from 0.3 up to (but not including) 0.7 are NOTIFY', () => {
    expect(risk.getDecision(0.3)).toBe('NOTIFY');
    expect(risk.getDecision(0.69)).toBe('NOTIFY');
  });
  it('scores 0.7 and above are BLOCK', () => {
    expect(risk.getDecision(0.7)).toBe('BLOCK');
    expect(risk.getDecision(1)).toBe('BLOCK');
  });
});

describe('RiskEngine.calculateRisk (golden values verified against benchmark/runner/run.js)', () => {
  // These exact input/output pairs were captured from a real run of the
  // deterministic policy+risk benchmark (benchmark/scenarios/scenarios.yaml) —
  // if this test ever fails, either the scoring formula changed or the benchmark's
  // printed risk scores are now stale and should be re-verified together.
  it.each([
    // [label, input, expectedScore, expectedDecision]
    ['dev restart_deployment, high confidence, no cost', {
      action: 'restart_deployment', clusterTier: 'dev', blastRadius: 2,
      reversibility: 0.9, llmConfidence: 0.9, costImpact: 0,
    }, 0.1, 'AUTONOMOUS'],
    ['staging restart_deployment, moderate confidence', {
      action: 'restart_deployment', clusterTier: 'staging', blastRadius: 2,
      reversibility: 0.9, llmConfidence: 0.8, costImpact: 0,
    }, 0.15, 'AUTONOMOUS'],
    // Note: these two score under the 0.3 AUTONOMOUS threshold on raw score alone.
    // ClusterAgent/the benchmark still route increase_memory to NOTIFY via the
    // separate HIGH_RISK_ACTIONS override — that override lives above this engine,
    // not inside calculateRisk(), so it's out of scope for this test file.
    ['dev scale_large (increase_memory), high confidence', {
      action: 'scale_large', clusterTier: 'dev', blastRadius: 2,
      reversibility: 0.5, llmConfidence: 0.85, costImpact: 100,
    }, 0.24, 'AUTONOMOUS'],
    ['dev scale_large (increase_memory), very high confidence', {
      action: 'scale_large', clusterTier: 'dev', blastRadius: 2,
      reversibility: 0.5, llmConfidence: 0.95, costImpact: 100,
    }, 0.23, 'AUTONOMOUS'],
    ['production apply_manifest (rollback)', {
      action: 'apply_manifest', clusterTier: 'production', blastRadius: 3,
      reversibility: 0.8, llmConfidence: 0.75, costImpact: 0,
    }, 0.44, 'NOTIFY'],
  ])('%s → score %s, decision %s', (_label, input, expectedScore, expectedDecision) => {
    const result = risk.calculateRisk(input);
    expect(result.score).toBe(expectedScore);
    expect(result.decision).toBe(expectedDecision);
  });

  it('clamps the final score to [0, 1]', () => {
    const result = risk.calculateRisk({
      action: 'delete_namespace', clusterTier: 'production', blastRadius: 100,
      reversibility: 0, llmConfidence: 0, costImpact: 100000,
    });
    expect(result.score).toBeLessThanOrEqual(1);
    expect(result.score).toBeGreaterThanOrEqual(0);
  });
});
