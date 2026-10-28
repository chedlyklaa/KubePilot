import { describe, it, expect, afterEach } from 'vitest';
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
    `kubectl --context=cluster2 patch deployment c2-badnodeselector -n demo10-c2 --type='json' -p='[{"op": "remove", "path": "/spec/template/spec/nodeSelector"}]'`,
    'kubectl --context=minikube logs "x" -n default',
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
    ['missing namespace on a write', 'kubectl --context=minikube scale deployment/x --replicas=3'],
    ['unquoted metachar alongside a legit quoted value', `kubectl --context=minikube logs "x" -n default; rm -rf /`],
    ['unterminated quote hiding a chained command', `kubectl --context=minikube logs x' ; rm -rf / -n default`],
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
    const r = pe.sanitizeCommand('kubectl --context=minikube rollout restart deployment/my-deploy- -n default');
    expect(r.safe).toBe(false);
  });
});

describe('PolicyEngine — dryRunMode default and overrides (§Fix-DryRunDefault)', () => {
  const ENV_KEY = 'ALLOW_LIVE_KUBECTL_EXECUTION';
  const originalEnv = process.env[ENV_KEY];
  afterEach(() => {
    if (originalEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = originalEnv;
  });

  it('defaults to true (simulate) with no constructor option and no env var', () => {
    delete process.env[ENV_KEY];
    expect(new PolicyEngine().dryRunMode).toBe(true);
  });

  it('defaults to true even if the env var is set to something other than the literal string "true"', () => {
    process.env[ENV_KEY] = 'yes';
    expect(new PolicyEngine().dryRunMode).toBe(true);
    process.env[ENV_KEY] = '1';
    expect(new PolicyEngine().dryRunMode).toBe(true);
  });

  it('ALLOW_LIVE_KUBECTL_EXECUTION=true flips the default to real execution', () => {
    process.env[ENV_KEY] = 'true';
    expect(new PolicyEngine().dryRunMode).toBe(false);
  });

  it('an explicit constructor option always wins over the env var', () => {
    process.env[ENV_KEY] = 'true';
    expect(new PolicyEngine({ dryRunMode: true }).dryRunMode).toBe(true);
    delete process.env[ENV_KEY];
    expect(new PolicyEngine({ dryRunMode: false }).dryRunMode).toBe(false);
  });

  it('every real call site (new PolicyEngine() with no arguments) is safe by default', () => {
    delete process.env[ENV_KEY];
    expect(new PolicyEngine().dryRunMode).toBe(true);
  });
});

describe('PolicyEngine.evaluateRiskOverridesForCommand — floors (§Fix-RiskEngineRetirement)', () => {
  function step(overrides = {}) {
    return { command: 'cordon node-1', risk: 'low', reversible: true, target: { kind: 'Node', name: 'node-1' }, ...overrides };
  }
  function ctx(overrides = {}) {
    return { tier: 'dev', oomKilled: false, deploymentExists: false, issueType: 'NodeNotReady', ...overrides };
  }

  it('elevates a drain command to HIGH even when Guardian rated it low risk and it is marked reversible', () => {
    const r = pe.evaluateRiskOverridesForCommand(
      step({ command: 'drain node-1 --ignore-daemonsets --timeout=60s', risk: 'low', reversible: true }),
      ctx()
    );
    expect(r.risk).toBe('HIGH');
    expect(r.forceApproval).toBe(true);
  });

  it('does NOT elevate a cordon command the same way — only drain is an absolute floor', () => {
    const r = pe.evaluateRiskOverridesForCommand(step({ command: 'cordon node-1', risk: 'low' }), ctx());
    expect(r.risk).toBe('LOW');
    expect(r.forceApproval).toBe(false);
  });

  it('does NOT false-match "uncordon" as a drain (no word boundary between "un" and "cordon")', () => {
    const r = pe.evaluateRiskOverridesForCommand(step({ command: 'uncordon node-1', risk: 'low' }), ctx());
    expect(r.risk).toBe('LOW');
  });

  it('control: OOM + resource change is still elevated to HIGH (pre-existing floor unaffected by the retirement)', () => {
    const r = pe.evaluateRiskOverridesForCommand(
      { command: 'set resources deployment/app -n default --limits=memory=512Mi', risk: 'low', reversible: true, target: { kind: 'Deployment', name: 'app' } },
      ctx({ oomKilled: true, issueType: 'OOMKilled' })
    );
    expect(r.risk).toBe('HIGH');
    expect(r.forceApproval).toBe(true);
  });

  it('control: a non-reversible step is still elevated to HIGH (pre-existing floor unaffected by the retirement)', () => {
    const r = pe.evaluateRiskOverridesForCommand(
      { command: 'delete pod x -n default', risk: 'low', reversible: false, target: { kind: 'Pod', name: 'x' } },
      ctx()
    );
    expect(r.risk).toBe('HIGH');
    expect(r.forceApproval).toBe(true);
  });
});
