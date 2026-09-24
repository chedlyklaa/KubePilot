'use strict';
// Plain Node script, not a Vitest test — same require()-cache-sharing pattern as the
// other verify-*.js scripts (mock mode) / plain harness scripts (real mode) in this
// directory.
//
// §Fix-PlannerConfidenceGateABTest (Phase 5, 2026-09-18) — compares:
//   A = current default behavior (planner.plan() with no opts — the low-confidence
//       gate applies exactly as it does in production today)
//   B = planner.plan(..., { forceCall: true }) — the gate is bypassed, the Planner LLM
//       is always called regardless of confidence
// on the same fixtures, and reports what each arm actually did.
//
// IMPORTANT — what this script does NOT do: it does not auto-score "was the proposed
// remediation correct". That requires either a human rater or a real cluster to
// execute against and re-check (the same methodology the dual-cluster benchmark
// uses) — neither is wired up here. What it DOES capture objectively: whether a
// command was proposed at all (arm A's gate, by construction, never proposes one for
// a low-confidence fixture — the interesting question is whether arm B's proposals
// look reasonable or reckless on manual review), what that command was, how many LLM
// calls/tool round-trips it took, and how long it took. Per the architecture review's
// own decision rule: only change the PRODUCTION default if arm B does not increase
// "incorrect remediation"/"unnecessary action" counts relative to arm A — since that
// judgment needs a human (or a real cluster) to make, this script's output is an
// input to that decision, not the decision itself.
//
// Fixtures below are representative RECONSTRUCTIONS of the two documented historical
// patterns that motivated keeping this gate (a missing-Secret case and a bad-image
// case — see the architecture review's Phase 3 table and
// pipeline_dryrun_bug_and_benchmark_audit memory note for `mk-missingsecret`/
// `c2-badimage`), not literal replays — the raw Investigator/Planner objects from
// those historical runs aren't recoverable from artifacts available in this sandbox
// (noop-repro-results/*.json only stores outcome summaries, not the raw RCA/plan
// objects), so these are built to have the same SHAPE (a real diagnosis exists, but
// confidence sits below the gate) rather than being pulled from the original data.
//
// ── Modes ────────────────────────────────────────────────────────────────────────
// --mock (default): monkey-patches the LLM boundary to prove the harness itself is
//   wired correctly (arm A makes zero real calls, arm B makes real calls) — zero cost,
//   zero cluster contact, safe to run any time.
// --real: makes REAL calls against your configured OPENAI_*/PLANNER_* endpoint (and,
//   if the Planner's tool loop uses dry_run_step/gather_more_evidence, real read-only/
//   --dry-run=server calls against the cluster context you pass). Costs real API
//   usage. NOT run automatically by this script's default — pass --real explicitly.

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

// Deliberately synthetic, clearly-fake resource names in a namespace that won't
// collide with anything real, even in --real mode against a real cluster.
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

// Mock diagnosis responses per fixture, ONLY used in --mock mode, matching the shape
// _runPlanningLoop's submit_plan tool call expects. Deliberately varied: one where
// the model still (correctly, per its own prompt instructions) declines to guess, one
// where it (plausibly, but unverifiably by this harness) proposes something concrete —
// exactly the kind of case a human needs to look at, which is the whole point.
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
      // Wiring assertions — proves the harness itself behaves as designed, not a
      // judgment about which arm is "better".
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
