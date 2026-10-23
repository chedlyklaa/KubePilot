import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { createRequire } from 'module';

// executor.js → PolicyEngine → config needs these — same pattern as the other test files.
process.env.OPENAI_API_KEY      ??= 'test-only-key';
process.env.OPENAI_MODEL        ??= 'test-model';
process.env.NOTIFICATION_SECRET ??= 'test-only-secret-not-a-real-value-0123456789';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const identity = require('./clusterIdentity.js');

afterEach(() => { delete process.env.CLUSTER_IDENTITY_MODE; });

describe('clusterIdentity scoping', () => {
  it('has no identity outside a scope, and the role inside it (across awaits)', async () => {
    expect(identity.currentIdentity()).toBeNull();
    await identity.withClusterIdentity('reader', async () => {
      await new Promise(r => setTimeout(r, 5));
      expect(identity.currentIdentity()).toBe('reader');
      await identity.withClusterIdentity('executor', async () => expect(identity.currentIdentity()).toBe('executor'));
      expect(identity.currentIdentity()).toBe('reader');
      identity.withoutIdentity(() => expect(identity.currentIdentity()).toBeNull());
    });
    expect(identity.currentIdentity()).toBeNull();
  });

  it('rejects unknown roles', () => {
    expect(() => identity.withClusterIdentity('admin', () => {})).toThrow(/unknown cluster identity role/);
  });

  it('falls through to the bootstrap credential unless mode is serviceaccount', async () => {
    await identity.withClusterIdentity('reader', async () => {
      expect(await identity.resolveKubeconfigPath('minikube')).toBeUndefined(); // default mode = bootstrap
    });
    process.env.CLUSTER_IDENTITY_MODE = 'serviceaccount';
    expect(await identity.resolveKubeconfigPath('minikube')).toBeUndefined();   // no scope → bootstrap
  });
});

describe('renderIdentityKubeconfig', () => {
  const base = { context: 'minikube', role: 'reader', token: 'tok-123' };

  it('carries ONLY the token — never a client cert/key that could bypass RBAC', () => {
    const cfg = yaml.load(identity.renderIdentityKubeconfig({ ...base, cluster: { server: 'https://1.2.3.4:8443', caData: 'Q0E=' } }));
    expect(cfg.users).toEqual([{ name: 'minikube-reader', user: { token: 'tok-123' } }]);
    const text = JSON.stringify(cfg);
    expect(text).not.toMatch(/client-certificate|client-key/);
  });

  it('keeps the original context name so --context=<name> still resolves', () => {
    const cfg = yaml.load(identity.renderIdentityKubeconfig({ ...base, cluster: { server: 'https://x' } }));
    expect(cfg['current-context']).toBe('minikube');
    expect(cfg.contexts[0]).toEqual({ name: 'minikube', context: { cluster: 'minikube', user: 'minikube-reader' } });
  });

  it('preserves the cluster trust settings (CA data, CA file, skip-verify)', () => {
    const withData = yaml.load(identity.renderIdentityKubeconfig({ ...base, cluster: { server: 'https://x', caData: 'Q0E=' } }));
    expect(withData.clusters[0].cluster).toEqual({ server: 'https://x', 'certificate-authority-data': 'Q0E=' });
    const withFile = yaml.load(identity.renderIdentityKubeconfig({ ...base, cluster: { server: 'https://x', caFile: '/ca.crt', skipTLSVerify: true } }));
    expect(withFile.clusters[0].cluster).toEqual({ server: 'https://x', 'certificate-authority': '/ca.crt', 'insecure-skip-tls-verify': true });
  });
});

describe('k8s gateway identities', () => {
  // Cold-loading the kubectl/executor/@kubernetes/client-node chain can take several
  // seconds on Windows — do it up front so the test's own timeout measures only behavior.
  let kubectl, readOnly, executor, gateway;
  beforeAll(() => {
    kubectl  = require('../tools/kubectl.js');
    readOnly = require('../tools/readOnlyKubectl.js');
    executor = require('../agents/executor.js');
    gateway  = require('../tools/k8sGateway.js');
  }, 60_000);

  it('runs every read method as reader and every write method as executor', async () => {
    // Swap the underlying modules for spies via the require cache, so nothing touches a cluster.
    const seen = [];
    const spy = name => async () => { seen.push([name, identity.currentIdentity()]); return name; };
    const orig = { getNodes: kubectl.getNodes, exec: readOnly.executeReadOnlyCommand, execute: executor.execute, dryRun: executor.dryRun };
    kubectl.getNodes = spy('getNodes');
    readOnly.executeReadOnlyCommand = spy('exec');
    executor.execute = spy('apply');
    executor.dryRun = spy('dryRun');
    try {
      const { readApi, writeApi } = gateway;
      await readApi.getNodes({ context: 'c' });
      await readApi.exec({ command: 'get pods', context: 'c' });
      await writeApi.apply({ step: {}, context: 'c' });
      await writeApi.dryRun({ step: {}, context: 'c' });
      expect(seen).toEqual([['getNodes', 'reader'], ['exec', 'reader'], ['apply', 'executor'], ['dryRun', 'executor']]);
    } finally {
      kubectl.getNodes = orig.getNodes;
      readOnly.executeReadOnlyCommand = orig.exec;
      executor.execute = orig.execute;
      executor.dryRun = orig.dryRun;
    }
  });
});
