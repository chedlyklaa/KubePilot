import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

// kubectl.js → sessionManager → notifications/crypto.js throws at load without this.
process.env.NOTIFICATION_SECRET ??= 'test-only-secret-not-a-real-value-0123456789';

const require = createRequire(import.meta.url);
const { findOverrideFlag } = require('./kubectlArgGuard.js');
const { _isReadOnlyCommand } = require('./readOnlyKubectl.js');

// Model-written commands must never choose their own cluster or credentials: kubectl's
// --kubeconfig/--context/... override the identity file and context the platform injects.

describe('findOverrideFlag', () => {
  it.each([
    ['get pods -A --kubeconfig=/var/run/kubepilot/kubeconfig/config', '--kubeconfig'],
    ['get pods --kubeconfig /etc/k', '--kubeconfig'],
    ['get pods "--kubeconfig=/etc/k"', '--kubeconfig'],
    ['get pods -n x --context=other', '--context'],
    ['get pods --server=https://evil:6443', '--server'],
    ['get pods -s https://evil:6443', '-s'],
    ['get pods -As https://evil:6443', '-s'],
    ['get pods --token=abc', '--token'],
    ['get pods --as=system:admin', '--as'],
    ['get pods --as-group=system:masters', '--as-group'],
    ['get pods --user=admin', '--user'],
    ['get pods --insecure-skip-tls-verify', '--insecure-skip-tls-verify'],
  ])('blocks %s', (cmd, flag) => {
    expect(findOverrideFlag(cmd)).toBe(flag);
  });

  it.each([
    'get pods -n kube-system -o wide',
    'get pods -ojsonpath={.items[*].status}',
    'get pods -l app=svc -A',
    'logs api-123 -n shop --tail=50 -p',
    'scale deployment/api --replicas=2 -n shop',
    'patch deployment api -n shop -p {"spec":{"replicas":2}}',
    'get sa -n kube-system',
  ])('allows %s', cmd => {
    expect(findOverrideFlag(cmd)).toBeNull();
  });
});

describe('read-only gate', () => {
  it.each([
    'get pods -A -o yaml --kubeconfig=/var/run/kubepilot/kubeconfig/config',
    'get pods -n shop --context=other',
    'get secrets.v1. -A -o yaml',
    'get secret.v1 -n shop',
    'get secrets.v1.core -A',
    'get pods,secrets.v1. -A',
    'get "secrets" -A',
    'get --raw /api/v1/namespaces/shop/secrets',
    'get --raw=/api/v1/secrets',
  ])('blocks %s', cmd => {
    expect(_isReadOnlyCommand(cmd).ok).toBe(false);
  });

  it.each([
    'get pods -n secret-storage',
    'describe pod api-1 -n shop',
    'get configmaps -A',
  ])('allows %s', cmd => {
    expect(_isReadOnlyCommand(cmd).ok).toBe(true);
  });
});
