import { describe, it, expect } from 'vitest';
import PolicyEngine from './policyEngine.js';

const pe = new PolicyEngine();

function plan(action, overrides = {}) {
  return {
    action,
    target: { kind: 'deployment', name: 'bench-app', namespace: 'default' },
    reason: 'test',
    risk: 'LOW',
    ...overrides,
  };
}
function ctx(overrides = {}) {
  return {
    cluster: 'dev-cluster',
    issueType: 'CrashLoopBackOff',
    tier: 'dev',
    deploymentExists: true,
    attemptHistory: [],
    ...overrides,
  };
}

describe('PolicyEngine.validate — rule by rule', () => {
  it('Rule 1: an unknown action is always rejected to noop', () => {
    const r = pe.validate(plan('delete_everything'), ctx());
    expect(r.status).toBe('rejected');
    expect(r.action).toBe('noop');
  });

  it('Rule 2: OOMKilled forces increase_memory even if a different action was proposed', () => {
    const r = pe.validate(plan('restart'), ctx({ oomKilled: true, issueType: 'OOMKilled' }));
    expect(r.status).toBe('modified');
    expect(r.action).toBe('increase_memory');
  });

  it('Rule 3: delete_pod on a controller-managed pod is overridden to restart', () => {
    const r = pe.validate(plan('delete_pod'), ctx({ deploymentExists: true }));
    expect(r.status).toBe('modified');
    expect(r.action).toBe('restart');
  });

  it('Rule 3a: scale_down with no Deployment controller is blocked to noop', () => {
    const r = pe.validate(plan('scale_down'), ctx({ deploymentExists: false, hasController: false }));
    expect(r.status).toBe('modified');
    expect(r.action).toBe('noop');
  });

  it('Rule 4: ImagePullBackOff only allows noop', () => {
    const r = pe.validate(plan('restart'), ctx({ issueType: 'ImagePullBackOff' }));
    expect(r.status).toBe('modified');
    expect(r.action).toBe('noop');
  });

  it('Rule 5: delete_pod on a Deployment-managed pod is hard-rejected in production', () => {
    const r = pe.validate(plan('delete_pod'), ctx({ tier: 'production', deploymentExists: true }));
    expect(r.status).toBe('rejected');
    expect(r.action).toBe('noop');
  });

  it('Rule 6: retry protection trips after two identical failures', () => {
    const r = pe.validate(plan('restart'), ctx({
      attemptHistory: [
        { action: 'restart', outcome: 'failed' },
        { action: 'restart', outcome: 'failed' },
      ],
    }));
    expect(r.status).toBe('modified');
    expect(r.action).toBe('noop');
  });

  it('Rule 7: delete_pod on a bare unmanaged pod is blocked to noop', () => {
    const r = pe.validate(plan('delete_pod'), ctx({ deploymentExists: false, hasController: false }));
    expect(r.status).toBe('modified');
    expect(r.action).toBe('noop');
  });

  it('Rule 7b: Job-owned pods only allow noop', () => {
    const r = pe.validate(plan('restart'), ctx({ ownerKind: 'Job' }));
    expect(r.status).toBe('modified');
    expect(r.action).toBe('noop');
  });

  it('Rule 8: a correlated recent deployment change forces rollback', () => {
    const r = pe.validate(plan('scale_down'), ctx({ recentDeployment: true, deploymentExists: true }));
    expect(r.status).toBe('modified');
    expect(r.action).toBe('rollback');
  });

  it('approves a clean action with nothing blocking it', () => {
    const r = pe.validate(plan('restart'), ctx());
    expect(r.status).toBe('approved');
    expect(r.action).toBe('restart');
  });

  it('flags high-risk actions in production for mandatory human approval', () => {
    const r = pe.validate(plan('increase_memory', { risk: 'HIGH' }), ctx({ tier: 'production', oomKilled: true, issueType: 'OOMKilled' }));
    expect(r.warnings.some(w => w.includes('POLICY_PROD_HIGH_RISK'))).toBe(true);
  });
});

describe('PolicyEngine.sanitizeCommand', () => {
  it.each([
    'kubectl --context=minikube cordon node-1',
    'kubectl --context=minikube uncordon node-1',
    'kubectl --context=minikube drain node-1 --ignore-daemonsets --timeout=60s',
    'kubectl --context=minikube logs --previous mypod -n default --tail=80',
    'kubectl --context=minikube describe pod mypod -n default',
    'kubectl --context=minikube rollout history deployment/mydep -n default',
    'kubectl --context=minikube get deployment/mydep -n default -o jsonpath={.spec.template.spec.containers[0].resources.limits.memory}',
    'kubectl --context=minikube get events -n default --field-selector involvedObject.name=mypod',
  ])('allows legitimate command: %s', cmd => {
    const r = pe.sanitizeCommand(cmd);
    expect(r.safe).toBe(true);
  });

  it.each([
    ['not kubectl at all',       'rm -rf /'],
    ['semicolon chaining',       'kubectl --context=minikube get pods -n default; rm -rf /'],
    ['backtick substitution',    'kubectl --context=minikube logs $(whoami) -n default'],
    ['pipe to a shell',          'kubectl --context=minikube get pods -n default | sh'],
    ['newline injection',        'kubectl --context=minikube get pods -n default\nrm -rf /'],
    ['double-quote breakout',    'kubectl --context=minikube logs "x" -n default'],
    ['missing namespace on a write', 'kubectl --context=minikube scale deployment/x --replicas=3'],
  ])('blocks: %s', (_label, cmd) => {
    const r = pe.sanitizeCommand(cmd);
    expect(r.safe).toBe(false);
  });

  it('forbids --force delete regardless of namespace', () => {
    const r = pe.sanitizeCommand('kubectl --context=minikube delete pod x -n default --force');
    expect(r.safe).toBe(false);
    expect(r.reason).toMatch(/force/i);
  });

  it('rejects an invalid resource name embedded after a type/ prefix', () => {
    // A trailing hyphen fails the k8s name pattern (must end alphanumeric).
    const r = pe.sanitizeCommand('kubectl --context=minikube rollout restart deployment/my-deploy- -n default');
    expect(r.safe).toBe(false);
  });
});
