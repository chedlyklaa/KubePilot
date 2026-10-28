'use strict';

process.env.OPENAI_API_KEY ??= 'test-only-key';
process.env.OPENAI_MODEL   ??= 'test-model';

const assert = require('assert');

const llmCircuitBreaker = require('../src/resilience/llmCircuitBreaker');
let nextRunLLMCall = async () => { throw new Error('scenario did not configure a response'); };
llmCircuitBreaker.runLLMCall = (...args) => nextRunLLMCall(...args);

const GuardianAgent = require('../src/agents/guardianAgent');
const guardian = new GuardianAgent('test-cluster', 'dev');

const BASE_PARAMS = {
  issue: { type: 'CrashLoopBackOff', podName: 'app-1', namespace: 'default', deployment: 'app', restartCount: 3, oomKilled: false },
  diagnosis: { action: 'restart the deployment', command: 'rollout restart deployment/app -n default', rootCause: 'transient crash', risk: 'MEDIUM' },
};

function rawResponse(raw) {
  return async () => ({ raw, usage: null });
}

async function scenarioLLMThrows_timeoutOrApiErrorOrStreamingFailure() {
  // Simulate an LLM timeout
  nextRunLLMCall = async () => { throw new Error('simulated LLM timeout'); };
  const result = await guardian.review(BASE_PARAMS);
  assert.notStrictEqual(result.verdict, 'APPROVE', 'LLM-throws: must never autonomously APPROVE');
  assert.strictEqual(result.verdict, 'DELEGATE_HUMAN', 'LLM-throws: should escalate to a human');
  assert.strictEqual(result.classification, 'DANGEROUS');
  assert.strictEqual(result.confidence, 0);
  console.log('PASS scenarioLLMThrows_timeoutOrApiErrorOrStreamingFailure:', result.verdict, '-', result.reason);
}

async function scenarioMalformedJson() {
  nextRunLLMCall = rawResponse('this is not JSON at all, the model rambled instead');
  const result = await guardian.review(BASE_PARAMS);
  assert.notStrictEqual(result.verdict, 'APPROVE', 'malformed-JSON: must never autonomously APPROVE');
  assert.strictEqual(result.verdict, 'DELEGATE_HUMAN');
  assert.strictEqual(result.classification, 'DANGEROUS');
  console.log('PASS scenarioMalformedJson:', result.verdict, '-', result.reason);
}

async function scenarioInvalidVerdictString() {
  nextRunLLMCall = rawResponse(JSON.stringify({
    verdict: 'MAYBE', classification: 'SAFE', reason: 'the model invented a verdict that is not in the enum',
  }));
  const result = await guardian.review(BASE_PARAMS);
  assert.notStrictEqual(result.verdict, 'APPROVE', 'invalid-verdict: must never silently default to APPROVE');
  assert.strictEqual(result.verdict, 'DELEGATE_HUMAN');
  assert.strictEqual(result.classification, 'DANGEROUS');
  console.log('PASS scenarioInvalidVerdictString:', result.verdict, '-', result.reason);
}

async function scenarioModifyWithoutSuggestedCommand() {
  nextRunLLMCall = rawResponse(JSON.stringify({
    verdict: 'MODIFY', classification: 'CAUTIOUS', reason: 'the original command is wrong but I forgot to say what to run instead',
    suggestedCommand: null, confidence: 0.6,
  }));
  const result = await guardian.review(BASE_PARAMS);
  assert.notStrictEqual(result.verdict, 'APPROVE', 'MODIFY-without-command: must never fall back to approving the original unreviewed command');
  assert.strictEqual(result.verdict, 'REJECT', 'MODIFY-without-command: should REJECT (bounded retry), not escalate straight to a human');
  assert.ok(result.reason.includes('did not provide a usable suggestedCommand'), 'reason should explain why it was rejected');
  console.log('PASS scenarioModifyWithoutSuggestedCommand:', result.verdict, '-', result.reason);
}

// Control case: valid approve
async function scenarioControl_validApprove() {
  nextRunLLMCall = rawResponse(JSON.stringify({
    verdict: 'APPROVE', classification: 'SAFE', reason: 'a scoped restart is correct for a transient crash',
    suggestedCommand: null, confidence: 0.9, safetyConcerns: [], evidenceCited: ['transient crash, restartCount=3'],
    impactSummary: 'restarts the deployment', estimatedBlastRadius: 'single_pod',
  }));
  const result = await guardian.review(BASE_PARAMS);
  assert.strictEqual(result.verdict, 'APPROVE', 'control: a genuinely valid APPROVE must still pass through unchanged');
  console.log('PASS scenarioControl_validApprove:', result.verdict);
}

async function scenarioControl_validModifyWithCommand() {
  nextRunLLMCall = rawResponse(JSON.stringify({
    verdict: 'MODIFY', classification: 'CAUTIOUS', reason: 'rollback is safer than restart here',
    suggestedCommand: 'rollout undo deployment/app -n default', confidence: 0.75,
  }));
  const result = await guardian.review(BASE_PARAMS);
  assert.strictEqual(result.verdict, 'MODIFY', 'control: a MODIFY WITH a usable suggestedCommand must still pass through unchanged');
  assert.strictEqual(result.suggestedCommand, 'rollout undo deployment/app -n default');
  console.log('PASS scenarioControl_validModifyWithCommand:', result.verdict, '-', result.suggestedCommand);
}

async function scenarioControl_validDelegateHuman() {
  nextRunLLMCall = rawResponse(JSON.stringify({
    verdict: 'DELEGATE_HUMAN', classification: 'DANGEROUS', reason: 'root cause is outside kubectl\'s reach',
    suggestedCommand: null, confidence: 0.85,
  }));
  const result = await guardian.review(BASE_PARAMS);
  assert.strictEqual(result.verdict, 'DELEGATE_HUMAN', 'control: a genuine model-decided DELEGATE_HUMAN must pass through, not be double-wrapped');
  assert.strictEqual(result.reason, 'root cause is outside kubectl\'s reach', 'control: reason should be the model\'s own, not the fail-closed placeholder text');
  console.log('PASS scenarioControl_validDelegateHuman:', result.verdict);
}

async function main() {
  await scenarioLLMThrows_timeoutOrApiErrorOrStreamingFailure();
  await scenarioMalformedJson();
  await scenarioInvalidVerdictString();
  await scenarioModifyWithoutSuggestedCommand();
  await scenarioControl_validApprove();
  await scenarioControl_validModifyWithCommand();
  await scenarioControl_validDelegateHuman();
  console.log('\nAll guardian fail-closed scenarios passed — no failure path produces an autonomous APPROVE.');
}

main().catch(err => { console.error('FAILED:', err); process.exit(1); });
