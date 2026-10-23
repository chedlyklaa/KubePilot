import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { guardedWriteApi, guardedReadApi, assertKnownContext, READ_METHODS, WRITE_METHODS } = require('./k8sGateway.js');
const overrideStore = require('../api/overrideStore.js');

// The gateway guard is the security boundary of the k8s-read/k8s-write services: a
// remote caller's context is untrusted and must be refused BEFORE any kubectl/executor
// code runs. These tests only exercise the refuse path, so nothing ever reaches a cluster.

describe('k8s gateway guard', () => {
  it('refuses an unknown context with a RefuseError (protocol-level refuse, not a crash)', () => {
    expect(() => assertKnownContext('prod-forged')).toThrow(expect.objectContaining({ refuse: true }));
    expect(() => assertKnownContext(undefined)).toThrow(expect.objectContaining({ refuse: true }));
  });

  it('guards every write method before the executor is touched', async () => {
    const api = guardedWriteApi();
    for (const m of WRITE_METHODS) {
      expect(() => api[m]({ step: { command: 'delete ns kube-system' }, context: 'prod-forged' }))
        .toThrow(/unknown kube context/);
    }
  });

  it('guards every read method', () => {
    const api = guardedReadApi();
    for (const m of READ_METHODS) {
      expect(() => api[m]({ command: 'get pods', context: 'nope' })).toThrow(/unknown kube context/);
    }
  });
});

describe('overrideStore.takeFor', () => {
  it('returns the override for the issue once, then clears it', () => {
    const issue = { type: 'CrashLoopBackOff', deployment: 'api', namespace: 'shop' };
    overrideStore.set(overrideStore.keyFor(issue), { preferredAction: 'rollback' });
    expect(overrideStore.takeFor(issue)).toEqual({ preferredAction: 'rollback' });
    expect(overrideStore.takeFor(issue)).toBeNull();
  });
});
