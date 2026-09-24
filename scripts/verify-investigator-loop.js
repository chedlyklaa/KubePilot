'use strict';
// Plain Node script, not a Vitest test — same reasoning/pattern as
// scripts/verify-guardian-failclosed.js and scripts/test-fastpath-live.js: this repo's
// Vitest can't reliably mock nested require() between plain CJS files, and
// investigator.js destructures `runStructuredLLMCall` at its own top-level require(),
// so the mock must be installed on the llmCircuitBreaker module object BEFORE
// investigator.js is first required, relying on the shared CommonJS require() cache.
//
// §Fix-ConvergenceSimplification (2026-09-18) — rewritten for the simplified loop
// (ring/convergence checkpoint system removed from investigator.js; see that file's
// own header comment for the full before/after). The model now has exactly two tools
// (run_readonly_kubectl_command, submit_investigation_report) and three deterministic
// acceptance floors on submission: at least one real tool call has run, the cited
// evidence isn't generic filler, and confidence/evidenceSufficiency both clear
// CONFIDENCE_TARGET. This drives the REAL _runInvestigationLoop (via the public
// investigate() entry point) through scripted multi-turn conversations proving each
// floor independently, plus both safety ceilings (turn count and wall clock) —
// no real LLM/kubectl/Redis/Mongo call happens anywhere in this script.

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
  // No checkpoint tool exists anymore — the model gathers evidence and submits
  // directly whenever IT decides it's ready.
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
  // The model tries to submit WITHOUT ever calling run_readonly_kubectl_command —
  // must be rejected by the new minimum-evidence-count floor, not accepted purely on
  // a self-reported high confidence.
  turnQueue = [
    turn(submitReport({ confidence: 0.95, evidenceSufficiency: 0.95 })), // rejected: zero real evidence gathered
    turn(readCommand('logs app-1 -n default')),
    turn(submitReport()), // now accepted
  ];
  const result = await investigator.investigate([ISSUE], CLUSTER_CONFIGS);
  assert.strictEqual(result.reachedConfidenceTarget, true, 'B: should eventually succeed after actually gathering evidence');
  assert.strictEqual(result.commandsExecuted.length, 1, 'B: exactly one real command should have run (the zero-evidence submission attempt does not count)');
  console.log('PASS scenarioB_minimumEvidenceFloor_zeroToolCalls:', { commandsRun: result.commandsExecuted.length });
}

async function scenarioC_evidenceQualityFloor_genericEvidence() {
  turnQueue = [
    turn(readCommand('describe pod app-1 -n default')),
    // Vague filler evidence — must be rejected even though confidence/evidenceSufficiency clear the bar.
    turn(submitReport({ evidence: ['the pod seems unhealthy'], confidence: 0.9, evidenceSufficiency: 0.9 })),
    // Concrete resubmission.
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
    turn(submitReport({ confidence: 0.3, evidenceSufficiency: 0.3 })), // below CONFIDENCE_TARGET, rejected
    turn(readCommand('logs app-1 -n default')),
    turn(submitReport({ confidence: 0.9, evidenceSufficiency: 0.9 })),
  ];
  const result = await investigator.investigate([ISSUE], CLUSTER_CONFIGS);
  assert.strictEqual(result.reachedConfidenceTarget, true, 'D: should succeed once confidence/evidenceSufficiency both clear the bar');
  assert.strictEqual(result.confidence, 0.9, 'D: the accepted report should be the high-confidence one, not the rejected low-confidence one');
  console.log('PASS scenarioD_confidenceGate_lowThenHigh:', { confidence: result.confidence });
}

async function scenarioE_modelFreelyChangesItsMindAcrossTurns() {
  // No regression guard exists anymore — the model is free to investigate one
  // hypothesis, find something that overturns it, and submit the LATEST belief with
  // no code-level pushback. This is the direct behavioral consequence of "LLM decides
  // DIAGNOSIS_READY" — confirming it works, not treating a change of mind as an error.
  turnQueue = [
    turn(readCommand('logs app-1 -n default')),
    // First hypothesis forming, but the model itself decides it's not ready yet — no
    // separate tool call needed to express that, it just keeps investigating.
    turn(readCommand('get events -n default')),
    // Evidence now points somewhere completely different — model submits ITS final,
    // revised belief directly, no prior "tracked best" to reconcile against.
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
  // The model never calls submit_investigation_report at all — every turn is a read
  // command. Confirms the hard 40-turn runaway cap still terminates the loop and
  // returns the honest zero-confidence fallback.
  turnQueue = Array.from({ length: 45 }, (_, i) => turn(readCommand(`get pods -n default -o json # turn ${i}`)));
  const result = await investigator.investigate([ISSUE], CLUSTER_CONFIGS);
  assert.strictEqual(result.reachedConfidenceTarget, false, 'F: never submitting anything must not be reported as having reached the target');
  assert.strictEqual(result.investigationExhausted, true);
  assert.strictEqual(result.stoppingOutcome, 'INVESTIGATION_BUDGET_EXHAUSTED');
  assert.strictEqual(result.confidence, 0, 'F: falls back to the honest zero-confidence placeholder, not a guessed value');
  console.log('PASS scenarioF_safetyCapExhaustedNoSubmission:', { confidence: result.confidence, turns: result.investigationTurns });
}

async function scenarioG_wallClockCapTerminatesEvenUnderTurnLimit() {
  // §Fix-ConvergenceSimplification's NEW ceiling — "maximum duration" per the target
  // architecture, previously not enforced at all (only turn COUNT was). Forces a real
  // small delay per turn and a tiny INVESTIGATOR_MAX_DURATION_MS so the wall-clock
  // check trips well before the 40-turn cap would.
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
