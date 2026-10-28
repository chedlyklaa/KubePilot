'use strict';

process.env.OPENAI_API_KEY      ??= 'test-only-key';
process.env.OPENAI_MODEL        ??= 'test-model';
process.env.NOTIFICATION_SECRET ??= 'test-only-secret-not-a-real-value-0123456789';

const assert = require('assert');

const kubectl = require('../src/tools/kubectl');
// Mock getPods returning a healthy pod
kubectl.getPods = async () => ({
  items: [{
    metadata: { name: 'app-1' },
    status: { phase: 'Running', containerStatuses: [{ ready: false, restartCount: 3, state: { waiting: { reason: 'CrashLoopBackOff' } } }] },
  }],
});

const reflectionAgent = require('../src/agents/reflectionAgent');
reflectionAgent.getContext = async () => ({ rules: [], structuralMatches: [], semanticMatches: [] });

const rootCauseFitAssessor = require('../src/agents/rootCauseFitAssessor');
let nextAdvisoryResponse = async () => { throw new Error('scenario did not configure an advisory response'); };
rootCauseFitAssessor.assessRootCauseFit = (...args) => nextAdvisoryResponse(...args);

const GuardianAgent = require('../src/agents/guardianAgent');
const { guardianNode } = require('../src/orchestrator/graph');

const CLUSTER_CONFIGS = { 'test-cluster': { name: 'test-cluster', context: 'test-ctx', tier: 'dev' } };
const ISSUE = { type: 'CrashLoopBackOff', clusterName: 'test-cluster', namespace: 'default', podName: 'app-1', deployment: 'app', restartCount: 3, oomKilled: false };
const ITEM = {
  step: { command: 'rollout restart deployment/app -n default', action: 'restart', reason: 'transient crash', risk: 'medium', target: { kind: 'Deployment', name: 'app', namespace: 'default' } },
  issue: ISSUE, key: 'test-cluster/default/app', diagnosis: null, verdict: null, policyResult: null,
};

function baseState() {
  return { clusterConfigs: CLUSTER_CONFIGS, items: [ITEM], attempt: 1, rca: { rootCause: 'transient crash', confidence: 0.9, suspected_cause: 'transient crash', risk_level: 'medium' }, podLogsByKey: {} };
}

async function scenario_advisoryDisagreesButVerdictUnaffected() {
  GuardianAgent.prototype.review = async () => ({
    verdict: 'APPROVE', classification: 'SAFE', reason: 'a scoped restart is correct for a transient crash',
    suggestedCommand: null, confidence: 0.9, safetyConcerns: [], evidenceCited: ['transient crash'],
    impactSummary: 'restarts the deployment', estimatedBlastRadius: 'single_pod',
  });
  // Mock advisory that disagrees with Guardian
  nextAdvisoryResponse = async () => ({ fit: 'NO', reason: 'this is deliberately the opposite of what Guardian decided', evidenceCited: ['x'] });

  const result = await guardianNode(baseState(), undefined);
  const verdict = result.items[0].verdict;
  assert.strictEqual(verdict.verdict, 'APPROVE', 'the advisory saying NO must not change an APPROVE verdict');
  console.log('PASS scenario_advisoryDisagreesButVerdictUnaffected:', { finalVerdict: verdict.verdict, advisorySaid: 'NO' });
}

async function scenario_advisoryFailureDoesNotBreakGuardianNode() {
  GuardianAgent.prototype.review = async () => ({
    verdict: 'APPROVE', classification: 'SAFE', reason: 'fine', suggestedCommand: null, confidence: 0.9,
    safetyConcerns: [], evidenceCited: ['x'], impactSummary: null, estimatedBlastRadius: null,
  });
  nextAdvisoryResponse = async () => { throw new Error('simulated advisory LLM outage'); };

  const result = await guardianNode(baseState(), undefined);
  const verdict = result.items[0].verdict;
  assert.strictEqual(verdict.verdict, 'APPROVE', 'an advisory call throwing must not break or change the real verdict');
  console.log('PASS scenario_advisoryFailureDoesNotBreakGuardianNode:', { finalVerdict: verdict.verdict });
}

async function scenario_regexRejectStillWinsAndSkipsTheAdvisoryEntirely() {
  // Mock Guardian review
  GuardianAgent.prototype.review = async () => ({
    verdict: 'APPROVE', classification: 'SAFE', reason: 'looks fine', suggestedCommand: null, confidence: 0.9,
    safetyConcerns: [], evidenceCited: ['x'], impactSummary: null, estimatedBlastRadius: null,
  });
  let advisoryCalled = false;
  nextAdvisoryResponse = async () => { advisoryCalled = true; return { fit: 'YES', reason: 'would have said yes', evidenceCited: [] }; };

  const state = baseState();
  state.rca = { rootCause: 'a nil pointer dereference in the application code', confidence: 0.9, suspected_cause: 'a nil pointer dereference in the application code', risk_level: 'high' };
  const result = await guardianNode(state, undefined);
  const verdict = result.items[0].verdict;
  assert.strictEqual(verdict.verdict, 'REJECT', 'the pre-existing enforced regex must still override APPROVE exactly as before Phase 4 was added');
  assert.strictEqual(advisoryCalled, false, 'the advisory must be skipped once the verdict is already REJECT — confirms the fixed skip condition (verdict-based, not just the local regex flag)');
  console.log('PASS scenario_regexRejectStillWinsAndSkipsTheAdvisoryEntirely:', { finalVerdict: verdict.verdict, advisoryCalled });
}

async function main() {
  await scenario_advisoryDisagreesButVerdictUnaffected();
  await scenario_advisoryFailureDoesNotBreakGuardianNode();
  await scenario_regexRejectStillWinsAndSkipsTheAdvisoryEntirely();
  console.log('\nAll rootCauseFitAssessor advisory-only scenarios passed — the Phase 4 experiment cannot affect any real verdict, and is correctly skipped once any prior override already decided the outcome.');
}

main().catch(err => { console.error('FAILED:', err); process.exit(1); });
