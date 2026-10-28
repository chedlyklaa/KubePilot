'use strict';

process.env.OPENAI_API_KEY      ??= 'test-only-key';
process.env.OPENAI_MODEL        ??= 'test-model';
process.env.NOTIFICATION_SECRET ??= 'test-only-secret-not-a-real-value-0123456789';

const assert = require('assert');

const llmCircuitBreaker = require('../src/resilience/llmCircuitBreaker');
let turnQueue = [];
llmCircuitBreaker.runStructuredLLMCall = async () => {
  if (turnQueue.length === 0) throw new Error('scenario script ran out of turns — investigator asked for another one');
  const next = turnQueue.shift();
  return typeof next === 'function' ? next() : next;
};

const kubectl = require('../src/tools/kubectl');
kubectl.runCommand = async (command) => `(scripted evidence for: ${command})`;

const shortMemory = require('../src/memory/shortMemory');
shortMemory.upsertIncident = async () => {};

const reflectionAgent = require('../src/agents/reflectionAgent');
reflectionAgent.getContext = async () => ({ rules: [], structuralMatches: [], semanticMatches: [] });

const investigator = require('../src/agents/investigator');

const CLUSTER_CONFIGS = { 'test-cluster': { name: 'test-cluster', context: 'test-ctx', tier: 'dev' } };
const ISSUE = { type: 'CrashLoopBackOff', clusterName: 'test-cluster', namespace: 'default', podName: 'app-1', deployment: 'app', restartCount: 4 };

let _callId = 0;
function toolCall(name, args) { return { name, args, id: `call-${++_callId}` }; }
function turn(...calls) { return { tool_calls: calls }; }
function readCommand(command, reasoning = 'gathering evidence') {
  return toolCall('run_readonly_kubectl_command', { clusterName: 'test-cluster', command, reasoning });
}
function submitReport(overrides = {}) {
  return toolCall('submit_investigation_report', {
    rootCause: 'application crash loop', layer: 'application', symptom: 'CrashLoopBackOff',
    componentsInvolved: ['app'], confidence: 0.9, evidence: ['log line: "panic: nil pointer dereference at main.go:42"'],
    recommendedFocus: 'none — evidence sufficient', riskLevel: 'medium',
    layersInspected: ['application'], perLayerFindings: [{ layer: 'application', status: 'critical', summary: 'crash', commandsRun: [] }],
    evidenceSufficiency: 0.9, severity: 'medium', reasoning: 'confident given the gathered evidence', ...overrides,
  });
}

async function scenarioA_directSubmissionAfterEvidence() {
  turnQueue = [
    turn(readCommand('logs app-1 -n default')),
    turn(submitReport()),
  ];
  const result = await investigator.investigate([ISSUE], CLUSTER_CONFIGS);
  assert.strictEqual(result.reachedConfidenceTarget, true, 'A: should reach the confidence target on a direct, well-evidenced submission');
  assert.strictEqual(result.stoppingOutcome, 'DIAGNOSIS_READY');
  assert.strictEqual(result.investigationTurns, 2, 'A: exactly 2 turns (one read, one submit) — no forced checkpoint round');
  console.log('PASS scenarioA_directSubmissionAfterEvidence:', { turns: result.investigationTurns, stoppingOutcome: result.stoppingOutcome });
}

async function scenarioB_minimumEvidenceFloor_zeroToolCalls() {
  turnQueue = [
    turn(submitReport({ confidence: 0.95, evidenceSufficiency: 0.95 })),
    turn(readCommand('logs app-1 -n default')),
    turn(submitReport()),
  ];
  const result = await investigator.investigate([ISSUE], CLUSTER_CONFIGS);
  assert.strictEqual(result.reachedConfidenceTarget, true, 'B: should eventually succeed after actually gathering evidence');
  assert.strictEqual(result.commandsExecuted.length, 1, 'B: exactly one real command should have run (the zero-evidence submission attempt does not count)');
  console.log('PASS scenarioB_minimumEvidenceFloor_zeroToolCalls:', { commandsRun: result.commandsExecuted.length });
}

async function scenarioC_evidenceQualityFloor_genericEvidence() {
  turnQueue = [
    turn(readCommand('describe pod app-1 -n default')),
    turn(submitReport({ evidence: ['the pod seems unhealthy'], confidence: 0.9, evidenceSufficiency: 0.9 })),
    turn(submitReport({ evidence: ['event reason=BackOff message="Back-off restarting failed container" count=12'] })),
  ];
  const result = await investigator.investigate([ISSUE], CLUSTER_CONFIGS);
  assert.strictEqual(result.reachedConfidenceTarget, true, 'C: should succeed once concrete evidence is cited');
  assert.ok(!result.evidence.some(e => /seems unhealthy/i.test(e)), 'C: the accepted report must not be the generic-evidence one');
  console.log('PASS scenarioC_evidenceQualityFloor_genericEvidence:', { evidence: result.evidence });
}

async function scenarioD_confidenceGate_lowThenHigh() {
  turnQueue = [
    turn(readCommand('get events -n default')),
    turn(submitReport({ confidence: 0.3, evidenceSufficiency: 0.3 })),
    turn(readCommand('logs app-1 -n default')),
    turn(submitReport({ confidence: 0.9, evidenceSufficiency: 0.9 })),
  ];
  const result = await investigator.investigate([ISSUE], CLUSTER_CONFIGS);
  assert.strictEqual(result.reachedConfidenceTarget, true, 'D: should succeed once confidence/evidenceSufficiency both clear the bar');
  assert.strictEqual(result.confidence, 0.9, 'D: the accepted report should be the high-confidence one, not the rejected low-confidence one');
  console.log('PASS scenarioD_confidenceGate_lowThenHigh:', { confidence: result.confidence });
}

async function scenarioE_modelFreelyChangesItsMindAcrossTurns() {
  turnQueue = [
    turn(readCommand('logs app-1 -n default')),
    turn(readCommand('get events -n default')),
    turn(submitReport({
      layer: 'node', rootCause: 'node under memory pressure, kubelet evicting pods',
      evidence: ['event reason=Evicted message="The node was low on resource: memory"'],
      confidence: 0.85, evidenceSufficiency: 0.85,
    })),
  ];
  const result = await investigator.investigate([ISSUE], CLUSTER_CONFIGS);
  assert.strictEqual(result.layer, 'node', 'E: the model\'s final, revised hypothesis should be accepted with no code-level pushback');
  console.log('PASS scenarioE_modelFreelyChangesItsMindAcrossTurns:', { finalLayer: result.layer });
}

async function scenarioF_safetyCapExhaustedNoSubmission() {
  turnQueue = Array.from({ length: 45 }, (_, i) => turn(readCommand(`get pods -n default -o json # turn ${i}`)));
  const result = await investigator.investigate([ISSUE], CLUSTER_CONFIGS);
  assert.strictEqual(result.reachedConfidenceTarget, false, 'F: never submitting anything must not be reported as having reached the target');
  assert.strictEqual(result.investigationExhausted, true);
  assert.strictEqual(result.stoppingOutcome, 'INVESTIGATION_BUDGET_EXHAUSTED');
  assert.strictEqual(result.confidence, 0, 'F: falls back to the honest zero-confidence placeholder, not a guessed value');
  console.log('PASS scenarioF_safetyCapExhaustedNoSubmission:', { confidence: result.confidence, turns: result.investigationTurns });
}

async function scenarioG_wallClockCapTerminatesEvenUnderTurnLimit() {
  process.env.INVESTIGATOR_MAX_DURATION_MS = '120';
  delete require.cache[require.resolve('../src/agents/investigator')];
  const freshInvestigator = require('../src/agents/investigator');

  turnQueue = Array.from({ length: 45 }, (_, i) => async () => {
    await new Promise(resolve => setTimeout(resolve, 60));
    return turn(readCommand(`get pods -n default -o json # turn ${i}`));
  });
  const result = await freshInvestigator.investigate([ISSUE], CLUSTER_CONFIGS);
  assert.strictEqual(result.reachedConfidenceTarget, false, 'G: should not have reached the target — stopped early by the wall-clock cap');
  assert.ok(result.investigationTurns < 40, `G: should stop well before the 40-turn cap via the wall-clock cap instead (got ${result.investigationTurns} turns)`);
  console.log('PASS scenarioG_wallClockCapTerminatesEvenUnderTurnLimit:', { turns: result.investigationTurns });
  delete process.env.INVESTIGATOR_MAX_DURATION_MS;
}

async function main() {
  await scenarioA_directSubmissionAfterEvidence();
  await scenarioB_minimumEvidenceFloor_zeroToolCalls();
  await scenarioC_evidenceQualityFloor_genericEvidence();
  await scenarioD_confidenceGate_lowThenHigh();
  await scenarioE_modelFreelyChangesItsMindAcrossTurns();
  await scenarioF_safetyCapExhaustedNoSubmission();
  await scenarioG_wallClockCapTerminatesEvenUnderTurnLimit();
  console.log('\nAll investigator loop scenarios passed against the simplified (post-ring/convergence-removal) loop.');
}

main().catch(err => { console.error('FAILED:', err); process.exit(1); });
