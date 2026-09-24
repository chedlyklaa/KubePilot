'use strict';
// Plain Node script, not a Vitest test — executor.js constructs its own internal
// `policyEngine = new PolicyEngine()` singleton at module load time, keyed off
// ALLOW_LIVE_KUBECTL_EXECUTION at THAT moment; Vitest's per-file module cache makes
// exercising two different env states for the same module awkward, and this repo's
// established pattern for exactly this class of problem (module-level state fixed at
// require() time) is a plain script, run once per state, invoked twice by the caller —
// see scripts/verify-guardian-failclosed.js's header for the same reasoning.
//
// §Fix-DryRunDefault (2026-09-18) — proves, for real, whether one Executor call path
// (a mutating pod command, a mutating node command, and the always-real dry_run_step
// validation path) actually reaches kubectl.runCommand() or not, under both the default
// (safe) and ALLOW_LIVE_KUBECTL_EXECUTION=true (real) states. kubectl.runCommand itself
// is monkey-patched to a recorder — never touches a real cluster regardless of which
// scenario is running.
//
// Usage:
//   node scripts/verify-dryrun-execution.js              → expects SIMULATE behavior
//   ALLOW_LIVE_KUBECTL_EXECUTION=true node scripts/verify-dryrun-execution.js  → expects REAL behavior

process.env.OPENAI_API_KEY      ??= 'test-only-key';
process.env.OPENAI_MODEL        ??= 'test-model';
process.env.NOTIFICATION_SECRET ??= 'test-only-secret-not-a-real-value-0123456789';

const assert = require('assert');

const kubectl = require('../src/tools/kubectl');
const calls = [];
kubectl.runCommand = async (command) => { calls.push(command); return '(recorded, no real cluster touched)'; };
kubectl.getNodes = async () => ({ items: [{ metadata: { name: 'other-node' }, spec: { unschedulable: false } }] });

const executor = require('../src/agents/executor');
const expectingLive = process.env.ALLOW_LIVE_KUBECTL_EXECUTION === 'true';

async function main() {
  console.log(`Mode under test: ${expectingLive ? 'ALLOW_LIVE_KUBECTL_EXECUTION=true (expect REAL execution)' : 'default (expect SIMULATE)'}`);

  // ── Scenario 1: a mutating pod-scoped command ──────────────────────────────────
  calls.length = 0;
  await executor.execute(
    { command: 'rollout restart deployment/app -n default', target: { kind: 'Deployment', name: 'app', namespace: 'default' } },
    { context: 'test-ctx' }
  );
  if (expectingLive) {
    assert.strictEqual(calls.length, 1, 'pod-scoped: expected exactly one real kubectl call');
    assert.match(calls[0], /rollout restart deployment\/app/, 'pod-scoped: recorded call should be the real command');
    console.log('PASS pod-scoped mutating command → REAL kubectl.runCommand call:', calls[0]);
  } else {
    assert.strictEqual(calls.length, 0, 'pod-scoped: expected zero real kubectl calls while simulating');
    console.log('PASS pod-scoped mutating command → SIMULATED, kubectl.runCommand never called');
  }

  // ── Scenario 2: a mutating node-scoped command ─────────────────────────────────
  calls.length = 0;
  await executor.execute(
    { command: 'cordon node-1', target: { kind: 'Node', name: 'node-1' } },
    { context: 'test-ctx' }
  );
  if (expectingLive) {
    assert.strictEqual(calls.length, 1, 'node-scoped: expected exactly one real kubectl call');
    assert.match(calls[0], /cordon node-1/, 'node-scoped: recorded call should be the real command');
    console.log('PASS node-scoped mutating command → REAL kubectl.runCommand call:', calls[0]);
  } else {
    assert.strictEqual(calls.length, 0, 'node-scoped: expected zero real kubectl calls while simulating');
    console.log('PASS node-scoped mutating command → SIMULATED, kubectl.runCommand never called');
  }

  // ── Scenario 3: dryRun() (the --dry-run=server validation path) always hits the
  // real API server regardless of dryRunMode — this is the one path that must NOT
  // change behavior between the two scenarios (see executor.js's own comment on why:
  // --dry-run=server never mutates regardless, so it should always get a real answer).
  calls.length = 0;
  await executor.dryRun(
    { command: 'rollout restart deployment/app -n default', target: { kind: 'Deployment', name: 'app', namespace: 'default' } },
    { context: 'test-ctx' }
  );
  assert.strictEqual(calls.length, 1, 'dry_run_step: must ALWAYS reach kubectl for real, regardless of dryRunMode');
  assert.match(calls[0], /--dry-run=server/, 'dry_run_step: command must carry --dry-run=server');
  console.log('PASS dryRun() validation path → ALWAYS a real (server-side, non-mutating) kubectl call, regardless of mode:', calls[0]);

  console.log(`\nAll scenarios confirmed ${expectingLive ? 'REAL execution' : 'SIMULATE'} behavior as expected for this mode.`);
}

main().catch(err => { console.error('FAILED:', err); process.exit(1); });
