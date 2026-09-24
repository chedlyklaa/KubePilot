'use strict';
// Plain Node script, not a Vitest test — same require()-cache-sharing pattern as the
// other verify-*.js scripts in this directory.
//
// §Fix-RootCauseFitExperiment (Phase 4, 2026-09-18) — proves, for real, that
// rootCauseFitAssessor's advisory check can NEVER change guardianNode's returned
// verdict, no matter what it says. This is the entire safety property Phase 4's
// design depends on ("logged, not enforced") — asserted here, not just claimed in a
// comment. Drives the REAL guardianNode (graph.js) with GuardianAgent.review and
// assessRootCauseFit both monkey-patched; no real LLM/kubectl call happens.
//
// IMPORTANT ordering note (this is the exact mistake that had to be fixed before this
// script worked correctly): graph.js does
// `const { assessRootCauseFit } = require('../agents/rootCauseFitAssessor');` at its
// own top-level require() — a DESTRUCTURED binding captured at that exact moment.
// Reassigning `rootCauseFitAssessor.assessRootCauseFit` on the module object AFTER
// graph.js has already been required does NOT change graph.js's own already-bound
// local reference — graph.js would keep calling the REAL function regardless, which
// on an earlier draft of this script silently made one real LLM call against the
// live configured endpoint. The mock (a stable wrapper delegating to a mutable
// variable, same pattern already used for llmCircuitBreaker.runStructuredLLMCall in
// the other verify-*.js scripts) MUST be installed before graph.js is first required.

process.env.OPENAI_API_KEY      ??= 'test-only-key';
process.env.OPENAI_MODEL        ??= 'test-model';
process.env.NOTIFICATION_SECRET ??= 'test-only-secret-not-a-real-value-0123456789';

const assert = require('assert');

const kubectl = require('../src/tools/kubectl');
// Returns the exact incident pod as healthy/present so §Fix-P8/§Fix-TargetGone (both
// unrelated deterministic overrides) don't fire and confound this test's own assertions.
kubectl.getPods = async () => ({
  items: [{
    metadata: { name: 'app-1' },
    status: { phase: 'Running', containerStatuses: [{ ready: false, restartCount: 3, state: { waiting: { reason: 'CrashLoopBackOff' } } }] },
  }],
});

const reflectionAgent = require('../src/agents/reflectionAgent');
reflectionAgent.getContext = async () => ({ rules: [], structuralMatches: [], semanticMatches: [] });

// Install the mock BEFORE graph.js is ever required, so its destructured
// `assessRootCauseFit` binding captures THIS wrapper, not the real function.
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
  // The advisory disagrees as strongly as possible with Guardian's APPROVE — if this
  // has ANY effect on the returned verdict, the "advisory only" guarantee is broken.
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
  // Root cause matches the EXISTING regex (nil pointer + restart) — the enforced gate
  // should still fire exactly as before Phase 4 was added, and the advisory should be
  // skipped entirely (nothing left to usefully compare against an already-rejected verdict).
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
