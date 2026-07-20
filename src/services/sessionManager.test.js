// Scope note: sessionManager.js hard-imports the real ClusterCredential Mongoose model
// (no injectable seam, unlike permissionService.getEligibleRecipients), so the
// DB-touching functions (storeCredential, getKubeconfigPath, invalidate,
// deleteCredential) aren't covered here — they'd need a real MongoDB connection or a
// module-level mock, which this codebase's existing tests deliberately avoid (see the
// comment in permissionService.test.js). What's covered instead is the part that's
// actually most bug-prone and fully deterministic: parsing/validating an uploaded
// kubeconfig and the connectivity check's fail-fast-before-any-network-call behavior.
//
// sessionManager.js requires NOTIFICATION_SECRET at import time (via
// notifications/crypto.js). Static `import` is hoisted above any top-level code in ESM,
// so setting process.env before a static import wouldn't actually run first — the
// module under test is loaded dynamically in beforeAll() instead, after the env var is set.
import { describe, it, expect, beforeAll } from 'vitest';
import yaml from 'js-yaml';

let canonicalContext, normalizeKubeconfig, testConnection;

beforeAll(async () => {
  process.env.NOTIFICATION_SECRET ||= 'test-secret-not-for-production-use-only';
  // sessionManager.js pulls in the full db/models barrel (mongoose schema registration
  // across 5 files) on first import, which is slow enough on a cold run to need more
  // than vitest's default 10s hook timeout.
  ({ canonicalContext, normalizeKubeconfig, testConnection } = await import('./sessionManager.js'));
}, 30_000);

function singleContextConfig({ contextName = 'my-ctx', clusterName = 'my-cluster', userName = 'my-user', namespace } = {}) {
  return yaml.dump({
    apiVersion: 'v1',
    kind: 'Config',
    'current-context': contextName,
    clusters: [{ name: clusterName, cluster: { server: 'https://example.com:6443', 'certificate-authority-data': 'YWJj' } }],
    users:    [{ name: userName, user: { 'client-certificate-data': 'ZGVm', 'client-key-data': 'Z2hp' } }],
    contexts: [{ name: contextName, context: { cluster: clusterName, user: userName, ...(namespace && { namespace }) } }],
  });
}

describe('sessionManager.canonicalContext', () => {
  it('prefixes with kp- and lowercases', () => {
    expect(canonicalContext('Azure-Prod')).toBe('kp-azure-prod');
  });

  it('strips characters outside a-z0-9 and collapses repeats', () => {
    expect(canonicalContext('my_cluster!! v2')).toBe('kp-my-cluster-v2');
  });

  it('trims leading/trailing dashes produced by sanitization', () => {
    expect(canonicalContext('--weird--name--')).toBe('kp-weird-name');
  });

  it('is deterministic for the same input', () => {
    expect(canonicalContext('cluster2')).toBe(canonicalContext('cluster2'));
  });

  it('produces different contexts for different names (no accidental collisions)', () => {
    expect(canonicalContext('cluster2')).not.toBe(canonicalContext('cluster2-copy'));
  });
});

describe('sessionManager.normalizeKubeconfig', () => {
  it('renames cluster/user/context to the canonical name and sets current-context', () => {
    const raw = singleContextConfig();
    const out = yaml.load(normalizeKubeconfig(raw, 'kp-my-cluster'));

    expect(out['current-context']).toBe('kp-my-cluster');
    expect(out.clusters).toHaveLength(1);
    expect(out.clusters[0].name).toBe('kp-my-cluster');
    expect(out.users[0].name).toBe('kp-my-cluster');
    expect(out.contexts[0].name).toBe('kp-my-cluster');
    expect(out.contexts[0].context.cluster).toBe('kp-my-cluster');
    expect(out.contexts[0].context.user).toBe('kp-my-cluster');
  });

  it('preserves the actual server/cert/key data untouched', () => {
    const raw = singleContextConfig();
    const out = yaml.load(normalizeKubeconfig(raw, 'kp-my-cluster'));

    expect(out.clusters[0].cluster.server).toBe('https://example.com:6443');
    expect(out.clusters[0].cluster['certificate-authority-data']).toBe('YWJj');
    expect(out.users[0].user['client-certificate-data']).toBe('ZGVm');
  });

  it('preserves an explicit namespace, defaults to "default" when absent', () => {
    const withNs    = yaml.load(normalizeKubeconfig(singleContextConfig({ namespace: 'team-a' }), 'ctx'));
    const withoutNs = yaml.load(normalizeKubeconfig(singleContextConfig(), 'ctx'));

    expect(withNs.contexts[0].context.namespace).toBe('team-a');
    expect(withoutNs.contexts[0].context.namespace).toBe('default');
  });

  it('rejects a kubeconfig with zero contexts', () => {
    const raw = yaml.dump({ apiVersion: 'v1', kind: 'Config', clusters: [], users: [], contexts: [] });
    expect(() => normalizeKubeconfig(raw, 'ctx')).toThrow(/exactly one context/i);
  });

  it('rejects a kubeconfig with more than one context (a full, un-minified kubeconfig)', () => {
    const raw = yaml.dump({
      apiVersion: 'v1', kind: 'Config',
      clusters: [{ name: 'a', cluster: { server: 'https://a' } }, { name: 'b', cluster: { server: 'https://b' } }],
      users:    [{ name: 'u1', user: {} }, { name: 'u2', user: {} }],
      contexts: [
        { name: 'ctx-a', context: { cluster: 'a', user: 'u1' } },
        { name: 'ctx-b', context: { cluster: 'b', user: 'u2' } },
      ],
    });
    expect(() => normalizeKubeconfig(raw, 'ctx')).toThrow(/exactly one context/i);
  });

  it('rejects a context that references a cluster entry which does not exist', () => {
    const raw = yaml.dump({
      apiVersion: 'v1', kind: 'Config',
      clusters: [], // referenced cluster "missing-cluster" is not defined here
      users:    [{ name: 'u', user: {} }],
      contexts: [{ name: 'ctx', context: { cluster: 'missing-cluster', user: 'u' } }],
    });
    expect(() => normalizeKubeconfig(raw, 'ctx')).toThrow(/missing the cluster or user entry/i);
  });

  it('rejects a context that references a user entry which does not exist', () => {
    const raw = yaml.dump({
      apiVersion: 'v1', kind: 'Config',
      clusters: [{ name: 'c', cluster: { server: 'https://a' } }],
      users:    [], // referenced user "missing-user" is not defined here
      contexts: [{ name: 'ctx', context: { cluster: 'c', user: 'missing-user' } }],
    });
    expect(() => normalizeKubeconfig(raw, 'ctx')).toThrow(/missing the cluster or user entry/i);
  });

  it('rejects text that is not valid YAML', () => {
    expect(() => normalizeKubeconfig('{{{ not: yaml: at all', 'ctx')).toThrow(/not valid YAML/i);
  });
});

describe('sessionManager.testConnection', () => {
  // These only exercise the structural-validation gate, which runs and throws before
  // any temp file is written or kubectl is spawned — no real cluster or network access
  // needed. The "successfully connects" happy path needs a live cluster and belongs in
  // an integration test, not here.
  it('rejects a multi-context kubeconfig without attempting to connect', async () => {
    const raw = yaml.dump({
      apiVersion: 'v1', kind: 'Config',
      clusters: [{ name: 'a', cluster: { server: 'https://a' } }, { name: 'b', cluster: { server: 'https://b' } }],
      users:    [{ name: 'u1', user: {} }, { name: 'u2', user: {} }],
      contexts: [
        { name: 'ctx-a', context: { cluster: 'a', user: 'u1' } },
        { name: 'ctx-b', context: { cluster: 'b', user: 'u2' } },
      ],
    });
    await expect(testConnection(raw)).rejects.toThrow(/exactly one context/i);
  });

  it('rejects invalid YAML without attempting to connect', async () => {
    await expect(testConnection('not: [valid yaml')).rejects.toThrow(/not valid YAML/i);
  });
});
