'use strict';
// Plain Node script, not a Vitest test — this repo's Vitest can't reliably mock nested
// require() calls between plain CJS files (see project memory / graph.js's test
// history), so LLM-adjacent control-flow like this is verified here instead: monkey-
// patch the module(s) under test's dependencies BEFORE requiring anything, relying on
// the shared CommonJS require() cache. Same pattern as scripts/test-investigator-rings.js.
//
// Scope: fastPathNode's own wiring (graph.js) — issueTrackerStore/shortMemory calls,
// state shape returned, routing outcome — driven with a monkey-patched
// fastPath.diagnose() so no real LLM/kubectl call happens. fastPath.js's own internal
// logic (profile selection, the InvestigationReportSchema adapter) is covered
// separately by its exported pure helpers (_selectProfile/_toInvestigationReport).

process.env.OPENAI_API_KEY      ??= 'test-only-key';
process.env.OPENAI_MODEL        ??= 'test-model';
process.env.NOTIFICATION_SECRET ??= 'test-only-secret-not-a-real-value-0123456789';

const assert = require('assert');

const shortMemory = require('../src/memory/shortMemory');
shortMemory.upsertIncident = async () => {};

const issueTrackerStore = require('../src/api/issueTrackerStore');
const tracked = [];
issueTrackerStore.track = async (key, ctx) => { tracked.push({ key, ...ctx }); return 1; };

const fastPath = require('../src/agents/fastPath');
const { fastPathNode } = require('../src/orchestrator/graph');

const CLUSTER_CONFIGS = { 'test-cluster': { name: 'test-cluster', context: 'test-ctx', tier: 'dev' } };
const ISSUE = {
  type: 'CrashLoopBackOff', clusterName: 'test-cluster', namespace: 'default',
  podName: 'app-1', deployment: 'app', complexity: 'SIMPLE',
};

async function scenario1_sufficientProceedsToPlanner() {
  tracked.length = 0;
  fastPath.diagnose = async () => ({
    escalate: false, reason: null, toolCallCount: 2,
    evidenceBundle: { profile: 'CrashLoopBackOff', currentLogs: 'panic: nil pointer' },
    diagnosis: {
      rootCause: 'application panics on nil pointer dereference', confidence: 0.9,
      supportingEvidence: ['log line: "panic: nil pointer dereference"'],
      alternativeHypotheses: [], missingInformation: [],
      evidenceSufficient: true, requiresDeepInvestigation: false,
      severity: 'high', reasoning: 'clear panic trace in current logs',
    },
  });

  const result = await fastPathNode({ issues: [ISSUE], clusterConfigs: CLUSTER_CONFIGS, workflowId: 'wf-1', attempt: 0 }, undefined);

  assert.strictEqual(result.fastPathOutcome, 'sufficient', 'scenario1: outcome should be sufficient');
  assert.strictEqual(result.attempt, 1, 'scenario1: attempt should be incremented like investigatorNode does');
  assert.strictEqual(result.blockReason, null, 'scenario1: blockReason should be cleared/null');
  assert.ok(result.rca, 'scenario1: rca should be populated');
  assert.strictEqual(result.rca.rootCause, 'application panics on nil pointer dereference');
  assert.strictEqual(result.rca.fastPath, true, 'scenario1: rca should be marked fastPath:true');
  assert.ok(result.podLogsByKey['test-cluster/default/app'].includes('panic'), 'scenario1: podLogsByKey should reuse the evidence bundle logs');
  assert.ok(tracked.some(t => t.stage === 'investigated'), 'scenario1: should have tracked an "investigated" stage');
  console.log('PASS scenario1_sufficientProceedsToPlanner:', { outcome: result.fastPathOutcome, rootCause: result.rca.rootCause, confidence: result.rca.confidence });
}

async function scenario2_insufficientEscalatesWithSeed() {
  tracked.length = 0;
  fastPath.diagnose = async () => ({
    escalate: true, reason: 'below fast-path confidence/evidence bar', toolCallCount: 2,
    evidenceBundle: { profile: 'CrashLoopBackOff', currentLogs: 'connection refused to db:5432' },
    diagnosis: {
      rootCause: 'unclear — possibly a downstream dependency issue', confidence: 0.4,
      supportingEvidence: ['log line: "connection refused to db:5432"'],
      alternativeHypotheses: ['db pod down', 'network policy blocking traffic'],
      missingInformation: ['check db pod status', 'check network policies in namespace'],
      evidenceSufficient: false, requiresDeepInvestigation: true,
      severity: 'medium', reasoning: 'evidence points at a dependency but does not confirm which one',
    },
  });

  const result = await fastPathNode({ issues: [ISSUE], clusterConfigs: CLUSTER_CONFIGS, workflowId: 'wf-2', attempt: 0 }, undefined);

  assert.strictEqual(result.fastPathOutcome, 'escalate', 'scenario2: outcome should be escalate');
  assert.ok(!('rca' in result), 'scenario2: should NOT set rca — Full Investigator produces the real one');
  assert.ok(result.fastPathSeed, 'scenario2: fastPathSeed should be populated');
  assert.strictEqual(result.fastPathSeed.diagnosis.rootCause, 'unclear — possibly a downstream dependency issue');
  assert.strictEqual(result.fastPathSeed.evidenceBundle.currentLogs, 'connection refused to db:5432');
  assert.ok(tracked.some(t => t.note?.includes('escalated to full investigation')), 'scenario2: should have tracked the escalation reason');
  console.log('PASS scenario2_insufficientEscalatesWithSeed:', { outcome: result.fastPathOutcome, seedRootCause: result.fastPathSeed.diagnosis.rootCause });
}

async function scenario3_multiIssueGroupFallsBackDefensively() {
  tracked.length = 0;
  const result = await fastPathNode({ issues: [ISSUE, { ...ISSUE, podName: 'app-2' }], clusterConfigs: CLUSTER_CONFIGS, workflowId: 'wf-3', attempt: 0 }, undefined);
  assert.strictEqual(result.fastPathOutcome, 'escalate', 'scenario3: a >1-issue group must fall back to escalate, never guess which issue to diagnose');
  assert.strictEqual(tracked.length, 0, 'scenario3: should not even attempt tracking/gathering for a group it refuses to handle');
  console.log('PASS scenario3_multiIssueGroupFallsBackDefensively:', { outcome: result.fastPathOutcome });
}

async function main() {
  await scenario1_sufficientProceedsToPlanner();
  await scenario2_insufficientEscalatesWithSeed();
  await scenario3_multiIssueGroupFallsBackDefensively();
  console.log('\nAll fastPathNode scenarios passed.');
}

main().catch(err => { console.error('FAILED:', err); process.exit(1); });
