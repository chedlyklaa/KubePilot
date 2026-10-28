import { describe, it, expect } from 'vitest';
import { issueKey } from './issueKey.js';

describe('issueKey', () => {
  it('keys a pod-scoped issue by cluster/namespace/resource', () => {
    expect(issueKey({ scope: 'pod', clusterName: 'cluster-a', namespace: 'payments', podName: 'api-1' }))
      .toBe('cluster-a/payments/api-1');
  });

  it('prefers deployment over podName for the resource segment', () => {
    expect(issueKey({ scope: 'pod', clusterName: 'cluster-a', namespace: 'payments', deployment: 'api', podName: 'api-1' }))
      .toBe('cluster-a/payments/api');
  });

  it('keys a node-scoped issue by cluster/node', () => {
    expect(issueKey({ scope: 'node', clusterName: 'cluster-a', nodeName: 'worker-1' }))
      .toBe('cluster-a/node:worker-1');
  });

  it('falls back to "default" namespace and "unknown" resource when absent', () => {
    expect(issueKey({ scope: 'pod', clusterName: 'cluster-a' })).toBe('cluster-a/default/unknown');
  });

  it('falls back to "unknown" cluster when clusterName is absent — last resort, not a normal path', () => {
    expect(issueKey({ scope: 'pod', namespace: 'payments', podName: 'api-1' })).toBe('unknown/payments/api-1');
  });

  it('produces DIFFERENT keys for identical namespace/resource across different clusters', () => {
    const a = issueKey({ scope: 'pod', clusterName: 'cluster-a', namespace: 'backend', podName: 'api-1' });
    const b = issueKey({ scope: 'pod', clusterName: 'cluster-b', namespace: 'backend', podName: 'api-1' });
    expect(a).not.toBe(b);
  });

  it('produces DIFFERENT keys for identically-named nodes across different clusters', () => {
    const a = issueKey({ scope: 'node', clusterName: 'cluster-a', nodeName: 'worker-1' });
    const b = issueKey({ scope: 'node', clusterName: 'cluster-b', nodeName: 'worker-1' });
    expect(a).not.toBe(b);
  });

  it('produces the SAME key for the same cluster/namespace/resource across two calls', () => {
    const a = issueKey({ scope: 'pod', clusterName: 'cluster-a', namespace: 'backend', podName: 'api-1' });
    const b = issueKey({ scope: 'pod', clusterName: 'cluster-a', namespace: 'backend', podName: 'api-1' });
    expect(a).toBe(b);
  });
});
