'use strict';

process.env.OPENAI_API_KEY      ??= 'test-only-key';
process.env.OPENAI_MODEL        ??= 'test-model';
process.env.NOTIFICATION_SECRET ??= 'test-only-secret-not-a-real-value-0123456789';
process.env.FASTPATH_MAX_EVIDENCE_REQUESTS = '3';

const assert = require('assert');

const llmCircuitBreaker = require('../src/resilience/llmCircuitBreaker');
let callQueue = [];
llmCircuitBreaker.runStructuredLLMCall = async () => {
  if (callQueue.length === 0) throw new Error('scenario ran out of scripted LLM calls');
  const next = callQueue.shift();
  return typeof next === 'function' ? next() : next;
};

const kubectl = require('../src/tools/kubectl');
const realCommandsRun = [];
kubectl.runCommand = async (command) => { realCommandsRun.push(command); return `(scripted evidence for: ${command})`; };

const fastPath = require('../src/agents/fastPath');

const CLUSTER_CONFIGS = { 'test-cluster': { name: 'test-cluster', context: 'test-ctx', tier: 'dev' } };
const ISSUE = { type: 'CrashLoopBackOff', clusterName: 'test-cluster', namespace: 'default', podName: 'app-1', deployment: 'app', restartCount: 4 };

function evidenceSelection(commands) { return { commands }; }
function diagnosisResponse(overrides = {}) {
  return {
    rootCause: 'application panics on startup', confidence: 0.9,
    supportingEvidence: ['log line: "panic: nil pointer dereference"'],
    alternativeHypotheses: [], missingInformation: [],
    evidenceSufficient: true, requiresDeepInvestigation: false,
    severity: 'high', layer: 'application', reasoning: 'clear panic trace in current logs', ...overrides,
  };
}

async function scenario_capEnforcedWhenModelAsksForMore() {
  realCommandsRun.length = 0;
  callQueue = [
    evidenceSelection([
      { command: 'describe pod app-1 -n default', reasoning: 'a' },
      { command: 'logs app-1 -n default', reasoning: 'b' },
      { command: 'logs app-1 -n default --previous', reasoning: 'c' },
      { command: 'get events -n default', reasoning: 'd — should NOT run, over the cap' },
      { command: 'get pods -n default -o json', reasoning: 'e — should NOT run, over the cap' },
    ]),
    diagnosisResponse(),
  ];
  const result = await fastPath.diagnose(ISSUE, CLUSTER_CONFIGS);
  assert.strictEqual(realCommandsRun.length, 3, 'exactly MAX_EVIDENCE_REQUESTS commands should actually execute, regardless of how many were requested');
  assert.strictEqual(result.toolCallCount, 3);
  assert.strictEqual(result.escalate, false);
  console.log('PASS scenario_capEnforcedWhenModelAsksForMore:', { requested: 5, executed: realCommandsRun.length });
}

async function scenario_writeCommandRejectedByExecutionLayerNotFastPathItself() {
  realCommandsRun.length = 0;
  callQueue = [
    evidenceSelection([{ command: 'delete pod app-1 -n default', reasoning: 'trying to sneak a write past the selection prompt' }]),
    diagnosisResponse({ evidenceSufficient: false, requiresDeepInvestigation: true, confidence: 0.3 }),
  ];
  const result = await fastPath.diagnose(ISSUE, CLUSTER_CONFIGS);
  assert.strictEqual(realCommandsRun.length, 0, 'a write command must never reach kubectl.runCommand — rejected by the shared read-only allowlist first');
  assert.ok(result.evidenceBundle.results[0].result.startsWith('ERROR:'), 'the rejected command should surface as an ERROR result to the diagnosis call, not silently vanish');
  console.log('PASS scenario_writeCommandRejectedByExecutionLayerNotFastPathItself:', { result: result.evidenceBundle.results[0].result });
}

async function scenario_zeroCommandsRequestedStillReachesDiagnosis() {
  realCommandsRun.length = 0;
  callQueue = [
    evidenceSelection([]),
    diagnosisResponse({ supportingEvidence: ['restartCount=4 and type=CrashLoopBackOff already fully describe this'] }),
  ];
  const result = await fastPath.diagnose(ISSUE, CLUSTER_CONFIGS);
  assert.strictEqual(realCommandsRun.length, 0);
  assert.strictEqual(result.escalate, false, 'zero requested commands is a legitimate model choice, not an error');
  console.log('PASS scenario_zeroCommandsRequestedStillReachesDiagnosis:', { escalate: result.escalate });
}

async function scenario_lowConfidenceDiagnosisEscalates() {
  callQueue = [
    evidenceSelection([{ command: 'get pods -n default -o json', reasoning: 'checking status' }]),
    diagnosisResponse({ confidence: 0.4, evidenceSufficient: false, requiresDeepInvestigation: true }),
  ];
  const result = await fastPath.diagnose(ISSUE, CLUSTER_CONFIGS);
  assert.strictEqual(result.escalate, true, 'below the confidence bar should still escalate to the full Investigator, same contract as before Phase 6');
  console.log('PASS scenario_lowConfidenceDiagnosisEscalates:', { escalate: result.escalate });
}

async function scenario_evidenceSelectionFailureEscalates() {
  callQueue = [async () => { throw new Error('simulated selection-call outage'); }];
  const result = await fastPath.diagnose(ISSUE, CLUSTER_CONFIGS);
  assert.strictEqual(result.escalate, true, 'a failed evidence-selection call must escalate to the Full Investigator, never crash or silently proceed');
  console.log('PASS scenario_evidenceSelectionFailureEscalates:', { reason: result.reason });
}

async function scenario_toInvestigationReportAdapterUsesModelReportedLayer() {
  const diagnosis = diagnosisResponse({ layer: 'node' });
  const bundle = { profile: 'llm-selected', results: [{ command: 'describe pod app-1 -n default', reasoning: 'x', result: 'y' }] };
  const rca = fastPath.toInvestigationReport(diagnosis, ISSUE, bundle);
  assert.strictEqual(rca.layer, 'node', 'the adapter should use the model\'s own reported layer now, not a fixed profile->layer lookup');
  console.log('PASS scenario_toInvestigationReportAdapterUsesModelReportedLayer:', { layer: rca.layer });
}

async function main() {
  await scenario_capEnforcedWhenModelAsksForMore();
  await scenario_writeCommandRejectedByExecutionLayerNotFastPathItself();
  await scenario_zeroCommandsRequestedStillReachesDiagnosis();
  await scenario_lowConfidenceDiagnosisEscalates();
  await scenario_evidenceSelectionFailureEscalates();
  await scenario_toInvestigationReportAdapterUsesModelReportedLayer();
  console.log('\nAll FastPath bounded-evidence scenarios passed.');
}

main().catch(err => { console.error('FAILED:', err); process.exit(1); });
