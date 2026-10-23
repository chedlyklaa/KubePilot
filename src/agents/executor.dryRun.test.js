import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

// kubectl.js → sessionManager → notifications/crypto.js throws at load without this.
process.env.NOTIFICATION_SECRET ??= 'test-only-secret-not-a-real-value-0123456789';

const require = createRequire(import.meta.url);
const kubectl = require('../tools/kubectl.js');
const executor = require('./executor.js');

// executor.dryRun is exposed over the bus to the (LLM-driven) Planner: whatever the
// command says, what reaches kubectl must end in --dry-run=server. kubectl.runCommand is
// stubbed, so nothing reaches a cluster.

describe('executor.dryRun never mutates', () => {
  let ran, original;
  beforeEach(() => {
    ran = [];
    original = kubectl.runCommand;
    kubectl.runCommand = async cmd => { ran.push(cmd); return 'ok'; };
  });
  afterEach(() => { kubectl.runCommand = original; });

  it.each([
    'scale deploy api --replicas=0 -n prod --dry-run=none',
    'scale deploy api --replicas=0 -n prod --dry-run=client',
    'scale deploy api --replicas=0 -n prod --dry-run',
    'scale deploy api --replicas=0 -n prod --dry-run=server',
    'scale deploy api --replicas=0 -n prod',
  ])('%s → runs with exactly one --dry-run=server, last', async command => {
    await executor.dryRun({ command, target: { kind: 'Deployment', name: 'api' } }, { context: 'minikube' });
    expect(ran).toHaveLength(1);
    expect(ran[0].match(/--dry-run/g)).toHaveLength(1);
    expect(ran[0]).toMatch(/ --dry-run=server$/);
  });

  it('refuses a "--" separator, which would turn the appended flag into a positional arg', async () => {
    const out = await executor.dryRun({ command: 'exec api-1 -n prod -- rm -rf /data', target: { kind: 'Pod', name: 'api-1' } }, { context: 'minikube' });
    expect(out).toMatch(/^BLOCKED/);
    expect(ran).toHaveLength(0);
  });

  it('rejects a step that tries to pick its own credentials or cluster', async () => {
    await expect(executor.dryRun({ command: 'scale deploy api --replicas=0 -n prod --kubeconfig=/etc/k', target: { kind: 'Deployment' } }, { context: 'minikube' }))
      .rejects.toThrow(/--kubeconfig is not allowed/);
    await expect(executor.execute({ command: 'scale deploy api --replicas=0 -n prod --context=other', target: { kind: 'Deployment' } }, { context: 'minikube' }))
      .rejects.toThrow(/--context is not allowed/);
    expect(ran).toHaveLength(0);
  });
});
