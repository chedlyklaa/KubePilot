import { describe, it, expect, beforeAll } from 'vitest';

process.env.OPENAI_API_KEY      ??= 'test-only-key';
process.env.OPENAI_MODEL        ??= 'test-model';
process.env.NOTIFICATION_SECRET ??= 'test-only-secret-not-a-real-value-0123456789';

let routeAfterPlanner, routeAfterPolicy, shouldEscalate, requiresApproval, MAX_FIX_ATTEMPTS, _toIssue, _clusterFor, _issueForStep, _actionCannotAddressRootCause, routeAfterExecutor, _issueResolution;

beforeAll(async () => {
  ({ routeAfterPlanner, routeAfterPolicy, shouldEscalate, requiresApproval, MAX_FIX_ATTEMPTS, _toIssue, _clusterFor, _issueForStep, _actionCannotAddressRootCause, routeAfterExecutor, _issueResolution } =
    await import('./graph.js'));
});

describe('_toIssue', () => {
  it('carries clusterName through from the incident', () => {
    const issue = _toIssue({ type: 'CrashLoopBackOff', scope: 'pod', clusterName: 'cluster-a', namespace: 'payments', podName: 'api-1' });
    expect(issue.clusterName).toBe('cluster-a');
  });

  it('defaults clusterName to null when the incident has none', () => {
    const issue = _toIssue({ type: 'CrashLoopBackOff', scope: 'pod', namespace: 'payments', podName: 'api-1' });
    expect(issue.clusterName).toBeNull();
  });
});

describe('_clusterFor', () => {
  const clusterConfigs = { 'cluster-a': { name: 'cluster-a', context: 'ctx-a', tier: 'production' } };

  it('resolves a known cluster from the fleet map', () => {
    expect(_clusterFor(clusterConfigs, 'cluster-a')).toEqual({ name: 'cluster-a', context: 'ctx-a', tier: 'production' });
  });

  it('returns context: null for an unknown cluster rather than throwing OR guessing a real context', () => {
    const result = _clusterFor(clusterConfigs, 'cluster-missing');
    expect(result).toEqual({ name: 'cluster-missing', context: null, tier: 'dev' });
  });
});

describe('_issueForStep', () => {
  const issueA = { clusterName: 'cluster-a', namespace: 'payments', deployment: 'api', podName: null, nodeName: null };
  const issueB = { clusterName: 'cluster-a', namespace: 'payments', deployment: 'worker', podName: null, nodeName: null };
  const issueC = { clusterName: 'cluster-b', namespace: 'payments', deployment: 'worker', podName: null, nodeName: null };

  it('resolves by target identity when issueKeys are absent', () => {
    const step = { issueKeys: [], target: { kind: 'Deployment', name: 'worker', namespace: 'payments' } };
    expect(_issueForStep(step, [issueA, issueB])).toBe(issueB);
  });

  it('falls back to issues[0] unchanged when every issue in the group shares one cluster', () => {
    const step = { issueKeys: [], target: { kind: 'Deployment', name: 'no-such-deployment', namespace: 'payments' } };
    expect(_issueForStep(step, [issueA, issueB])).toBe(issueA);
  });

  it('nulls out clusterName instead of guessing when the group spans multiple clusters', () => {
    const step = { issueKeys: [], target: { kind: 'Deployment', name: 'no-such-deployment', namespace: 'payments' } };
    const result = _issueForStep(step, [issueA, issueC]);
    expect(result.clusterName).toBeNull();
  });
});

describe('_actionCannotAddressRootCause (§Fix-RootCauseGate / §Fix-ExecutorHonesty)', () => {
  it('blocks a restart proposed for a confirmed third-party outage (P10, both clusters)', () => {
    const reason = _actionCannotAddressRootCause({
      rootCause: 'Application startup failure due to a third-party outage: DNS resolution is failing for the external payment processor API (api.stripe-processor-external.example.com), which is confirmed as an external service disruption.',
      evidenceSummary: 'Pod billing-minikube-3z9 failing — logs show it cannot reach the external payment processor API. The processor\'s own status page confirms a provider-wide outage.',
      command: 'rollout restart deployment/billing -n shop',
    });
    expect(reason).toMatch(/external\/third-party outage/);
  });

  it('blocks a restart proposed for a recurring nil-pointer crash (P9-minikube)', () => {
    const reason = _actionCannotAddressRootCause({
      rootCause: 'Application crash due to nil pointer dereference in syncHandler during startup',
      evidenceSummary: 'Pod sync-worker-minikube-6f4 in CrashLoopBackOff. This pod has ALREADY been restarted twice in the past hour by an earlier remediation attempt — the crash recurs within 2 minutes each time. 22 restarts total.',
      command: 'rollout restart deployment/sync-worker -n shop',
    });
    expect(reason).toMatch(/recurring code-level crash/);
  });

  it('blocks a delete pod proposed for a recurring code crash too, not just restart', () => {
    const reason = _actionCannotAddressRootCause({
      rootCause: 'Repeated null pointer exception in the request handler on every startup attempt',
      evidenceSummary: '',
      command: 'delete pod worker-7f8 -n shop',
    });
    expect(reason).toMatch(/recurring code-level crash/);
  });

  it('does NOT block a rollback (rollout undo) for a recurring code crash — that IS a reasonable response', () => {
    const reason = _actionCannotAddressRootCause({
      rootCause: 'Application crash due to nil pointer dereference in syncHandler during startup',
      evidenceSummary: 'This pod has ALREADY been restarted twice — the crash recurs within 2 minutes each time.',
      command: 'rollout undo deployment/sync-worker -n shop',
    });
    expect(reason).toBeNull();
  });

  it('control case: does NOT block a transient-crash restart (P1)', () => {
    const reason = _actionCannotAddressRootCause({
      rootCause: 'Application startup failure due to timeout when connecting to a downstream dependency. The dependency is either temporarily unavailable or too slow to respond during the pod\'s initialization phase, causing it to exceed retry limits and crash. Previous restarts of the same pod have succeeded, indicating a transient or timing-dependent issue rather than a persistent misconfiguration.',
      evidenceSummary: 'Pod api-minikube-7f8 in CrashLoopBackOff, exit code 1, 8 restarts in the last 20 minutes.',
      command: 'rollout restart deployment/api -n shop',
    });
    expect(reason).toBeNull();
  });

  it('control case: does NOT block on "outage"-adjacent language without an external/third-party qualifier', () => {
    const reason = _actionCannotAddressRootCause({
      rootCause: 'The cache pod is crashing because it cannot connect to the redis-master service; the dependency appears unavailable within the cluster.',
      evidenceSummary: '',
      command: 'rollout restart deployment/cache -n shop',
    });
    expect(reason).toBeNull();
  });

  it('control case: a bare-pod delete with no code-crash language stays allowed (P5)', () => {
    const reason = _actionCannotAddressRootCause({
      rootCause: 'The container image does not contain the entrypoint script /entrypoint-debug.sh, causing the container to fail immediately with \'No such file or directory\' upon startup.',
      evidenceSummary: 'Bare pod adhoc-debug-minikube (no owning controller) in CrashLoopBackOff, 15 restarts.',
      command: 'delete pod adhoc-debug-minikube -n default',
    });
    expect(reason).toBeNull();
  });

  it('returns null (no blockedReason) for a totally empty/unknown diagnosis rather than throwing', () => {
    expect(_actionCannotAddressRootCause({ rootCause: null, evidenceSummary: null, command: null })).toBeNull();
  });
});

describe('routeAfterPlanner', () => {
  it('routes a single-step plan with no command straight to reflexion, skipping Guardian', () => {
    expect(routeAfterPlanner({ items: [{ step: { action: 'no fix available', command: '' } }] })).toBe('reflexion');
  });

  it('routes any real command to guardian for review', () => {
    expect(routeAfterPlanner({ items: [{ step: { action: 'restart the deployment', command: 'rollout restart deployment/api -n prod' } }] })).toBe('guardian');
  });

  it('routes a multi-step plan to reflexion only when EVERY step has no command', () => {
    expect(routeAfterPlanner({ items: [
      { step: { action: 'no fix', command: '' } }, { step: { action: 'no fix', command: '' } },
    ] })).toBe('reflexion');
  });

  it('routes a mixed plan (one real command among no-ops) to guardian — nothing gets silently skipped', () => {
    expect(routeAfterPlanner({ items: [
      { step: { action: 'no fix', command: '' } }, { step: { action: 'restart', command: 'rollout restart deployment/api -n prod' } },
    ] })).toBe('guardian');
  });
});

describe('shouldEscalate', () => {
  it('does not escalate while attempts remain', () => {
    expect(shouldEscalate(1)).toBe(false);
    expect(shouldEscalate(MAX_FIX_ATTEMPTS - 1)).toBe(false);
  });

  it('escalates once the attempt count reaches the max', () => {
    expect(shouldEscalate(MAX_FIX_ATTEMPTS)).toBe(true);
    expect(shouldEscalate(MAX_FIX_ATTEMPTS + 1)).toBe(true);
  });
});

describe('requiresApproval', () => {
  it('requires approval when risk is HIGH regardless of reversibility', () => {
    expect(requiresApproval('HIGH', false, true)).toBe(true);
  });

  it('requires approval when Guardian itself flags approvalRequired', () => {
    expect(requiresApproval('LOW', true, true)).toBe(true);
  });

  it('requires approval for a non-reversible step even at LOW risk', () => {
    expect(requiresApproval('LOW', false, false)).toBe(true);
  });

  it('does not require approval for a low-risk, reversible step Guardian did not flag', () => {
    expect(requiresApproval('LOW', false, true)).toBe(false);
  });
});

describe('routeAfterPolicy', () => {
  it('routes an escalated outcome to reflexion (closes the loop, records the episode)', () => {
    expect(routeAfterPolicy({ outcome: 'escalated' })).toBe('reflexion');
  });

  it('routes a blocked outcome (e.g. denied approval) to reflexion', () => {
    expect(routeAfterPolicy({ outcome: 'blocked' })).toBe('reflexion');
  });

  it('routes a block reason (Guardian/Policy rejected, attempts remain) back to investigator', () => {
    expect(routeAfterPolicy({ blockReason: 'Guardian rejected: wrong action for this issue' })).toBe('investigator');
  });

  it('routes a clean approval through to executor', () => {
    expect(routeAfterPolicy({ outcome: null, blockReason: null })).toBe('executor');
  });

  it('routes to reflexion when every issue was resolved as already healthy (§Fix-AlreadyHealthyResolve)', () => {
    expect(routeAfterPolicy({ items: [], outcome: 'fixed', blockReason: 'stale' })).toBe('reflexion');
  });
});

describe('routeAfterExecutor (§Fix-RetryLoop)', () => {
  it('routes back to investigator when executorNode left a blockReason (attempts remain)', () => {
    expect(routeAfterExecutor({ blockReason: 'issue-1: pod is not yet healthy (phase=Pending)' })).toBe('investigator');
  });

  it('routes to reflexion (terminal) when there is no blockReason — either fixed or attempts exhausted', () => {
    expect(routeAfterExecutor({ blockReason: null })).toBe('reflexion');
    expect(routeAfterExecutor({})).toBe('reflexion');
  });
});

describe('_issueResolution', () => {
  it('is unresolved with no steps at all', () => {
    expect(_issueResolution([])).toEqual({ actionableSteps: [], resolved: false });
  });

  it('ignores skipped steps and requires every remaining actionable step to be fixed', () => {
    const steps = [
      { executionOutcome: 'skipped' },
      { executionOutcome: 'fixed' },
      { executionOutcome: 'fixed' },
    ];
    const result = _issueResolution(steps);
    expect(result.actionableSteps).toHaveLength(2);
    expect(result.resolved).toBe(true);
  });

  it('is unresolved if any actionable step in a multi-step plan failed, even if the first one succeeded', () => {
    const steps = [
      { executionOutcome: 'fixed' },
      { executionOutcome: 'blocked' },
    ];
    expect(_issueResolution(steps).resolved).toBe(false);
  });

  it('is unresolved when every step was skipped (nothing actionable at all)', () => {
    const steps = [{ executionOutcome: 'skipped' }, { executionOutcome: 'skipped' }];
    const result = _issueResolution(steps);
    expect(result.actionableSteps).toHaveLength(0);
    expect(result.resolved).toBe(false);
  });
});
