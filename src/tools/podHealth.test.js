import { describe, it, expect, beforeAll } from 'vitest';

process.env.NOTIFICATION_SECRET ??= 'test-only-secret-not-a-real-value-0123456789';

let verifyResourceHealthy, isActiveContainerProblem, isPodHealthy;

beforeAll(async () => {
  ({ verifyResourceHealthy, isActiveContainerProblem, isPodHealthy } = await import('./podHealth.js'));
});

// Fake kubectl module
function fakeKubectl({ pods = [], nodes = [], runCommand } = {}) {
  return {
    getPods: async () => ({ items: pods }),
    getNodes: async () => ({ items: nodes }),
    runCommand: runCommand ?? (async () => ''),
  };
}

function pod({ name = 'api-1', namespace = 'default', phase = 'Running', containers = [{ ready: true, restartCount: 0 }] } = {}) {
  return { metadata: { name, namespace }, status: { phase, containerStatuses: containers } };
}

function node({ name = 'node-1', unschedulable = false, ready = true } = {}) {
  return { metadata: { name }, spec: { unschedulable }, status: { conditions: [{ type: 'Ready', status: ready ? 'True' : 'False' }] } };
}

describe('isActiveContainerProblem', () => {
  it('is not a problem when ready with no restarts', () => {
    expect(isActiveContainerProblem({ ready: true, restartCount: 0 })).toBe(false);
  });

  it('is a problem when not ready', () => {
    expect(isActiveContainerProblem({ ready: false, restartCount: 0 })).toBe(true);
  });

  it('is a problem when currently waiting (e.g. CrashLoopBackOff)', () => {
    expect(isActiveContainerProblem({ ready: false, restartCount: 3, state: { waiting: { reason: 'CrashLoopBackOff' } } })).toBe(true);
  });

  it('is a problem when a restart happened recently, even if ready now', () => {
    const finishedAt = new Date(Date.now() - 60_000).toISOString();
    expect(isActiveContainerProblem({ ready: true, restartCount: 1, lastState: { terminated: { finishedAt } } })).toBe(true);
  });

  it('is not a problem when the only restart happened long ago (outside the recency window)', () => {
    const finishedAt = new Date(Date.now() - 60 * 60_000).toISOString();
    expect(isActiveContainerProblem({ ready: true, restartCount: 1, lastState: { terminated: { finishedAt } } })).toBe(false);
  });
});

describe('isPodHealthy', () => {
  it('is healthy when Running with every container ready and no restarts', () => {
    expect(isPodHealthy(pod())).toBe(true);
  });

  it('is not healthy for a CrashLoopBackOff pod caught briefly Running+Ready right after a restart', () => {
    const finishedAt = new Date(Date.now() - 30_000).toISOString();
    expect(isPodHealthy(pod({ containers: [{ ready: true, restartCount: 5, state: { running: {} }, lastState: { terminated: { finishedAt } } }] }))).toBe(false);
  });

  it('is not healthy when a container is waiting on an image pull', () => {
    expect(isPodHealthy(pod({ phase: 'Pending', containers: [{ ready: false, restartCount: 0, state: { waiting: { reason: 'ImagePullBackOff' } } }] }))).toBe(false);
  });
});

describe('verifyResourceHealthy — Pod', () => {
  const step = { command: 'kubectl delete pod api-1 -n default', target: { kind: 'Pod', name: 'api-1', namespace: 'default' } };

  it('reports healthy immediately when the named pod is Running and ready', async () => {
    const result = await verifyResourceHealthy(step, { context: 'ctx-a', timeoutSecs: 1, kubectl: fakeKubectl({ pods: [pod()] }) });
    expect(result.healthy).toBe(true);
  });

  it('reports unhealthy with a reason when the named pod is still crash-looping', async () => {
    const kubectl = fakeKubectl({ pods: [pod({ containers: [{ ready: false, restartCount: 5, state: { waiting: { reason: 'CrashLoopBackOff' } } }] })] });
    const result = await verifyResourceHealthy(step, { context: 'ctx-a', timeoutSecs: 1, kubectl });
    expect(result.healthy).toBe(false);
    expect(result.reason).toMatch(/not yet healthy/);
  });

  it('finds a healthy replacement pod by name-prefix when the named pod was deleted and the issue names its controller', async () => {
    const kubectl = fakeKubectl({ pods: [pod({ name: 'api-7f8d9-xk2p1' })] });
    const result = await verifyResourceHealthy(step, { issue: { deployment: 'api' }, context: 'ctx-a', timeoutSecs: 1, kubectl });
    expect(result.healthy).toBe(true);
  });

  it('reports unhealthy when the named pod is gone and no owning controller is known', async () => {
    const result = await verifyResourceHealthy(step, { context: 'ctx-a', timeoutSecs: 1, kubectl: fakeKubectl({ pods: [] }) });
    expect(result.healthy).toBe(false);
    expect(result.reason).toMatch(/no longer exists/);
  });

  it('times out and reports the last reason rather than hanging forever', async () => {
    const kubectl = fakeKubectl({ pods: [pod({ containers: [{ ready: false, restartCount: 0 }] })] });
    const result = await verifyResourceHealthy(step, { context: 'ctx-a', timeoutSecs: 0, kubectl });
    expect(result.healthy).toBe(false);
  });
});

describe('verifyResourceHealthy — Deployment/StatefulSet/DaemonSet', () => {
  it('is healthy when rollout status succeeds', async () => {
    let seenCommand;
    const kubectl = fakeKubectl({ runCommand: async cmd => { seenCommand = cmd; return 'deployment "api" successfully rolled out'; } });
    const step = { command: 'kubectl rollout restart deployment/api -n default', target: { kind: 'Deployment', name: 'api', namespace: 'default' } };
    const result = await verifyResourceHealthy(step, { context: 'ctx-a', timeoutSecs: 5, kubectl });
    expect(result.healthy).toBe(true);
    expect(seenCommand).toContain('rollout status deployment/api -n default');
  });

  it('is unhealthy when rollout status fails/times out', async () => {
    const kubectl = fakeKubectl({ runCommand: async () => { throw new Error('timed out waiting for the condition'); } });
    const step = { command: 'kubectl rollout restart statefulset/db -n default', target: { kind: 'StatefulSet', name: 'db', namespace: 'default' } };
    const result = await verifyResourceHealthy(step, { context: 'ctx-a', timeoutSecs: 5, kubectl });
    expect(result.healthy).toBe(false);
    expect(result.reason).toMatch(/rollout status did not succeed/);
  });
});

describe('verifyResourceHealthy — Node', () => {
  it('confirms a node is unschedulable again after cordon', async () => {
    const kubectl = fakeKubectl({ nodes: [node({ unschedulable: true })] });
    const step = { command: 'kubectl cordon node-1', target: { kind: 'Node', name: 'node-1' } };
    const result = await verifyResourceHealthy(step, { context: 'ctx-a', timeoutSecs: 1, kubectl });
    expect(result.healthy).toBe(true);
  });

  it('rejects a cordon that did not actually take effect', async () => {
    const kubectl = fakeKubectl({ nodes: [node({ unschedulable: false })] });
    const step = { command: 'kubectl cordon node-1', target: { kind: 'Node', name: 'node-1' } };
    const result = await verifyResourceHealthy(step, { context: 'ctx-a', timeoutSecs: 1, kubectl });
    expect(result.healthy).toBe(false);
  });

  it('confirms a node is schedulable again after uncordon', async () => {
    const kubectl = fakeKubectl({ nodes: [node({ unschedulable: false })] });
    const step = { command: 'kubectl uncordon node-1', target: { kind: 'Node', name: 'node-1' } };
    const result = await verifyResourceHealthy(step, { context: 'ctx-a', timeoutSecs: 1, kubectl });
    expect(result.healthy).toBe(true);
  });
});

describe('verifyResourceHealthy — generic kind (§Fix-VerifyGenericKind)', () => {
  it('is healthy when a live "kubectl get <kind> <name>" succeeds, for any kind', async () => {
    let seenCommand;
    const kubectl = fakeKubectl({ runCommand: async cmd => { seenCommand = cmd; return 'secret/smtp-credentials'; } });
    const step = { command: 'kubectl create secret generic smtp-credentials -n default --from-literal=smtp-api-key=placeholder', target: { kind: 'Secret', name: 'smtp-credentials', namespace: 'default' } };
    const result = await verifyResourceHealthy(step, { context: 'ctx-a', timeoutSecs: 1, kubectl });
    expect(result.healthy).toBe(true);
    expect(seenCommand).toContain('get secret smtp-credentials -n default');
  });

  it('is unhealthy with a reason when the object genuinely does not exist', async () => {
    const kubectl = fakeKubectl({ runCommand: async () => { throw new Error('secrets "smtp-credentials" not found'); } });
    const step = { command: 'kubectl apply -f x.yaml', target: { kind: 'ConfigMap', name: 'x', namespace: 'default' } };
    const result = await verifyResourceHealthy(step, { context: 'ctx-a', timeoutSecs: 1, kubectl });
    expect(result.healthy).toBe(false);
    expect(result.reason).toMatch(/not found/);
  });

  it('refuses when the step has no target at all', async () => {
    const result = await verifyResourceHealthy({ command: 'kubectl get pods' }, { context: 'ctx-a', kubectl: fakeKubectl() });
    expect(result.healthy).toBe(false);
  });
});
