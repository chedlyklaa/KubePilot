'use strict';

const MODE = process.argv.includes('--real') ? 'real' : 'mock';

process.env.OPENAI_API_KEY      ??= 'test-only-key';
process.env.OPENAI_MODEL        ??= 'test-model';
process.env.NOTIFICATION_SECRET ??= 'test-only-secret-not-a-real-value-0123456789';

const assert = require('assert');

let llmCircuitBreaker, kubectl;
let callLog = [];
if (MODE === 'mock') {
  llmCircuitBreaker = require('../src/resilience/llmCircuitBreaker');
  let nextResponse = async () => { throw new Error('fixture did not configure a mock response'); };
  llmCircuitBreaker.runStructuredLLMCall = async (fn) => { callLog.push('llm-call'); return nextResponse(fn); };
  kubectl = require('../src/tools/kubectl');
  kubectl.runCommand = async (command) => { callLog.push(`kubectl:${command}`); return '(mocked)'; };
  global.__setNextMockResponse = (fn) => { nextResponse = fn; };
}

const planner = require('../src/agents/planner');

const CLUSTER_CONFIGS = MODE === 'real'
  ? { minikube: { name: 'minikube', context: 'minikube', tier: 'dev' } }
  : { 'test-cluster': { name: 'test-cluster', context: 'test-ctx', tier: 'dev' } };
const CLUSTER = MODE === 'real' ? 'minikube' : 'test-cluster';

const FIXTURES = [
  {
    name: 'missing-secret-like (reconstructed from mk-missingsecret)',
    issues: [{ type: 'CreateContainerConfigError', clusterName: CLUSTER, namespace: 'abtest-planner-gate', podName: 'ab-missingsecret-x1', deployment: 'ab-missingsecret', restartCount: 0, oomKilled: false }],
    rca: {
      rootCause: 'pod cannot start — references a Secret that does not exist in this namespace, but it is unclear whether the Secret was deleted, renamed, or never created',
      confidence: 0.35, evidence: ['event reason=FailedMount message="secret \\"ab-missingsecret-creds\\" not found"'],
      recommendedFocus: 'confirm with a human whether this Secret should exist and what it should contain',
      riskLevel: 'medium', suspected_cause: 'missing Secret reference, cause of the deletion unknown', risk_level: 'medium',
    },
  },
  {
    name: 'bad-image-like (reconstructed from c2-badimage)',
    issues: [{ type: 'ImagePullBackOff', clusterName: CLUSTER, namespace: 'abtest-planner-gate', podName: 'ab-badimage-x1', deployment: 'ab-badimage', restartCount: 0, oomKilled: false }],
    rca: {
      rootCause: 'image pull fails — the tag may have been retagged or removed from the registry; the correct working tag is not evident from available evidence',
      confidence: 0.4, evidence: ['event reason=ErrImagePull message="manifest for myapp:v2.3-old not found"'],
      recommendedFocus: 'a human needs to confirm the correct current image tag',
      riskLevel: 'medium', suspected_cause: 'image tag no longer exists in the registry', risk_level: 'medium',
    },
  },
  {
    name: 'genuinely-ambiguous-crash (control — no strong historical pattern either way)',
    issues: [{ type: 'CrashLoopBackOff', clusterName: CLUSTER, namespace: 'abtest-planner-gate', podName: 'ab-ambiguous-x1', deployment: 'ab-ambiguous', restartCount: 2, oomKilled: false }],
    rca: {
      rootCause: 'container exits with code 1 shortly after startup; logs are sparse and do not show a clear stack trace or error message',
      confidence: 0.3, evidence: ['exit code 1, no stderr output captured'],
      recommendedFocus: 'more investigation needed — logs alone are inconclusive',
      riskLevel: 'medium', suspected_cause: 'unclear application-level failure', risk_level: 'medium',
    },
  },
];

const MOCK_PLANNER_RESPONSES = {
  'missing-secret-like (reconstructed from mk-missingsecret)': {
    tool_calls: [{ name: 'submit_plan', id: 'c1', args: { steps: [{
      action: 'no automated fix available', command: '', target: { kind: 'Pod', name: 'ab-missingsecret-x1', namespace: 'abtest-planner-gate' },
      reason: 'cannot safely recreate a Secret whose original contents are unknown', risk: 'medium', reversible: true, inverseCommand: null, issueKeys: [],
    }] } }],
  },
  'bad-image-like (reconstructed from c2-badimage)': {
    tool_calls: [{ name: 'submit_plan', id: 'c2', args: { steps: [{
      action: 'roll back to the previous revision', command: 'rollout undo deployment/ab-badimage -n abtest-planner-gate',
      target: { kind: 'Deployment', name: 'ab-badimage', namespace: 'abtest-planner-gate' },
      reason: 'the previous revision used a known-working image; rolling back avoids guessing a new tag', risk: 'medium', reversible: true,
      inverseCommand: 'rollout undo deployment/ab-badimage -n abtest-planner-gate --to-revision=0', issueKeys: [],
    }] } }],
  },
  'genuinely-ambiguous-crash (control — no strong historical pattern either way)': {
    tool_calls: [{ name: 'submit_plan', id: 'c3', args: { steps: [{
      action: 'restart the deployment', command: 'rollout restart deployment/ab-ambiguous -n abtest-planner-gate',
      target: { kind: 'Deployment', name: 'ab-ambiguous', namespace: 'abtest-planner-gate' },
      reason: 'transient crash, restart is the lowest-risk first attempt', risk: 'low', reversible: true, inverseCommand: null, issueKeys: [],
    }] } }],
  },
};

async function runArm(label, fixture, opts) {
  if (MODE === 'mock') global.__setNextMockResponse(async () => MOCK_PLANNER_RESPONSES[fixture.name]);
  callLog = [];
  const t0 = Date.now();
  const plan = await planner.plan(fixture.issues, fixture.rca, CLUSTER_CONFIGS, null, opts);
  const elapsedMs = Date.now() - t0;
  const proposedCommand = plan.steps.some(s => s.command) ? plan.steps.filter(s => s.command).map(s => s.command).join(' && ') : null;
  return {
    label, elapsedMs,
    llmCallsMade: MODE === 'mock' ? callLog.filter(c => c === 'llm-call').length : (plan._meta?.turnsUsed ?? 0),
    proposedCommand, stopReason: plan._meta?.diagnostics?.stopReason ?? null,
    steps: plan.steps.map(s => ({ action: s.action, command: s.command, risk: s.risk })),
  };
}

async function main() {
  console.log(`Mode: ${MODE}${MODE === 'mock' ? ' (proving the harness is wired correctly, zero cost)' : ' (REAL LLM/cluster calls against your configured endpoint)'}\n`);
  const report = [];

  for (const fixture of FIXTURES) {
    console.log(`━━━ ${fixture.name} (rca.confidence=${fixture.rca.confidence}) ━━━`);
    const armA = await runArm('A (current default — gate applies)', fixture, {});
    const armB = await runArm('B (forceCall — gate bypassed)', fixture, { forceCall: true });

    if (MODE === 'mock') {
      assert.strictEqual(armA.llmCallsMade, 0, 'arm A must make ZERO LLM calls below the confidence gate — this IS the production default, unchanged');
      assert.strictEqual(armA.proposedCommand, null, 'arm A must never propose a command below the gate');
      assert.ok(armB.llmCallsMade >= 1, 'arm B must actually call the LLM when forceCall is set');
    }

    console.log(`  A: llmCalls=${armA.llmCallsMade} proposedCommand=${armA.proposedCommand ?? '(none — escalates)'} (${armA.elapsedMs}ms)`);
    console.log(`  B: llmCalls=${armB.llmCallsMade} proposedCommand=${armB.proposedCommand ?? '(none — model itself declined)'} (${armB.elapsedMs}ms)`);
    console.log('');
    report.push({ fixture: fixture.name, confidence: fixture.rca.confidence, armA, armB });
  }

  console.log('━━━ SUMMARY (for human review — this script does not judge correctness) ━━━');
  for (const r of report) {
    console.log(`${r.fixture}:`);
    console.log(`  A proposed a command: ${r.armA.proposedCommand !== null} | B proposed a command: ${r.armB.proposedCommand !== null}`);
    if (r.armB.proposedCommand) console.log(`  B's proposal (needs human judgment — reasonable or reckless given confidence=${r.confidence}?): ${r.armB.proposedCommand}`);
  }
  if (MODE === 'mock') {
    console.log('\nAll wiring assertions passed. Re-run with --real to collect actual comparative data against your configured LLM (costs real API usage).');
  } else {
    console.log('\nReal run complete. This is a SMALL sample (n=' + FIXTURES.length + ') — per the architecture review\'s own caveat, treat this as directional, not conclusive, and do not change the production default from this alone.');
  }
}

main().catch(err => { console.error('FAILED:', err); process.exit(1); });
