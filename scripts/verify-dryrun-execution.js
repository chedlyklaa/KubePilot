'use strict';

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
