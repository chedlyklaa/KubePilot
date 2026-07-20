import { describe, it, expect } from 'vitest';
import {
  checkAccess, classifyCommand, parseCommandScope, filterClusters, getEligibleRecipients,
} from './permissionService.js';

// Fake finders matching the real User.find(...).select(...).lean() / Group.find(...) shape,
// passed via getEligibleRecipients' injectable `models` parameter — avoids mocking
// require('../db/models') at the module level (Vitest's ESM-oriented vi.mock does not
// reliably intercept a plain CJS require() call in a "type": "commonjs" project).
function fakeModels(users, groups = []) {
  const finder = result => ({ select() { return this; }, lean: () => Promise.resolve(result) });
  return {
    User:  { find: () => finder(users) },
    Group: { find: () => finder(groups) },
  };
}

describe('permissionService.checkAccess', () => {
  it('grants everything for a full wildcard admin grant', () => {
    const perms = [{ cluster: '*', namespace: '*', role: 'admin' }];
    expect(checkAccess(perms, 'prod', 'team-a', 'destructive')).toBe(true);
    expect(checkAccess(perms, 'prod', null, 'destructive')).toBe(true);
  });

  it('grants access on exact cluster + namespace + sufficient role', () => {
    const perms = [{ cluster: 'prod', namespace: 'team-a', role: 'editor' }];
    expect(checkAccess(perms, 'prod', 'team-a', 'scaling')).toBe(true);
  });

  it('denies access when the namespace does not match', () => {
    const perms = [{ cluster: 'prod', namespace: 'team-a', role: 'admin' }];
    expect(checkAccess(perms, 'prod', 'team-b', 'read-only')).toBe(false);
  });

  it('denies access when the cluster does not match', () => {
    const perms = [{ cluster: 'prod', namespace: '*', role: 'admin' }];
    expect(checkAccess(perms, 'staging', 'team-a', 'read-only')).toBe(false);
  });

  // Regression test for H1: a permission scoped to ONE namespace must not authorize
  // cluster-scoped operations (namespace === null, e.g. cordon_node/drain_node/get nodes).
  // Before the fix, `!namespace` short-circuited the namespace check to true for ANY
  // permission entry on the right cluster, letting a namespace-scoped grant cordon/drain
  // nodes cluster-wide. See src/services/permissionService.js:78.
  it('REGRESSION (H1): a namespace-scoped grant does NOT authorize cluster-scoped ops', () => {
    const perms = [{ cluster: 'prod', namespace: 'team-a', role: 'admin' }];
    expect(checkAccess(perms, 'prod', null, 'destructive')).toBe(false);
  });

  it('a cluster-wide grant (namespace "*") DOES authorize cluster-scoped ops', () => {
    const perms = [{ cluster: 'prod', namespace: '*', role: 'admin' }];
    expect(checkAccess(perms, 'prod', null, 'destructive')).toBe(true);
  });

  it('denies access when the role rank is insufficient', () => {
    const perms = [{ cluster: 'prod', namespace: '*', role: 'viewer' }];
    expect(checkAccess(perms, 'prod', 'default', 'destructive')).toBe(false);
  });

  it('grants access at exactly the minimum required role rank', () => {
    const perms = [{ cluster: 'prod', namespace: '*', role: 'editor' }];
    expect(checkAccess(perms, 'prod', 'default', 'scaling')).toBe(true); // scaling requires editor
  });

  it('grants access if ANY permission entry matches, even if others do not', () => {
    const perms = [
      { cluster: 'staging', namespace: '*', role: 'admin' },
      { cluster: 'prod', namespace: 'team-a', role: 'viewer' },
    ];
    expect(checkAccess(perms, 'prod', 'team-a', 'read-only')).toBe(true);
  });

  it('denies access for an empty permission set', () => {
    expect(checkAccess([], 'prod', 'default', 'read-only')).toBe(false);
  });

  it('requires admin for an unrecognized category (safest default)', () => {
    const perms = [{ cluster: 'prod', namespace: '*', role: 'editor' }];
    expect(checkAccess(perms, 'prod', 'default', 'some-unknown-category')).toBe(false);
    const adminPerms = [{ cluster: 'prod', namespace: '*', role: 'admin' }];
    expect(checkAccess(adminPerms, 'prod', 'default', 'some-unknown-category')).toBe(true);
  });
});

describe('permissionService.classifyCommand', () => {
  it.each([
    ['kubectl get pods -n default', 'read-only'],
    ['kubectl describe pod x -n default', 'read-only'],
    ['kubectl logs x -n default', 'read-only'],
    ['kubectl scale deployment/x --replicas=3 -n default', 'scaling'],
    ['kubectl rollout restart deployment/x -n default', 'rolling-update'],
    ['kubectl rollout undo deployment/x -n default', 'rolling-update'],
    ['kubectl set image deployment/x c=img -n default', 'config-change'],
    ['kubectl apply -f manifest.yaml', 'config-change'],
    ['kubectl uncordon node-1', 'config-change'],
    ['kubectl delete pod x -n default', 'destructive'],
    ['kubectl drain node-1', 'destructive'],
    ['kubectl cordon node-1', 'destructive'],
    ['kubectl taint node node-1 key=value:NoSchedule', 'destructive'],
  ])('classifies "%s" as %s', (cmd, expected) => {
    expect(classifyCommand(cmd)).toBe(expected);
  });

  it('defaults unknown verbs to the safest category (destructive)', () => {
    expect(classifyCommand('kubectl frobnicate x')).toBe('destructive');
  });
});

describe('permissionService.parseCommandScope', () => {
  it('extracts cluster (--context) and namespace (-n) from a command', () => {
    const scope = parseCommandScope('kubectl --context=prod get pods -n team-a');
    expect(scope.cluster).toBe('prod');
    expect(scope.namespace).toBe('team-a');
  });

  it('supports the long --namespace flag', () => {
    const scope = parseCommandScope('kubectl --context prod delete pod x --namespace=team-a');
    expect(scope.namespace).toBe('team-a');
  });

  it('returns null cluster/namespace when absent (cluster-scoped command)', () => {
    const scope = parseCommandScope('kubectl --context=prod cordon node-1');
    expect(scope.cluster).toBe('prod');
    expect(scope.namespace).toBeNull();
  });

  it('classifies correctly when the verb is the first token after "kubectl"', () => {
    expect(parseCommandScope('kubectl get pods -n default').category).toBe('read-only');
  });

  // REGRESSION (fixed): classifyCommand() used to only strip a literal "kubectl "
  // prefix before matching a verb — it did not skip --context=... first. Every command
  // this system actually generates puts --context immediately after "kubectl" and
  // before the verb (see interpretGraph.js's own prompt template: "kubectl
  // --context=CTX get pods -n NS", etc.), so in real usage this ALWAYS fell through to
  // the 'destructive' default regardless of the real verb — requiring admin role for
  // every command a non-admin submitted, including harmless reads. Fixed by stripping
  // recognized global flags (--context, -n/--namespace, --as/--as-group) before
  // verb-matching. See src/services/permissionService.js's _GLOBAL_FLAG_RE.
  it('REGRESSION: --context before the verb no longer defeats verb detection', () => {
    expect(parseCommandScope('kubectl --context=prod get pods -n team-a').category).toBe('read-only');
    expect(parseCommandScope('kubectl --context=prod logs mypod -n team-a').category).toBe('read-only');
    expect(parseCommandScope('kubectl --context=prod delete pod x -n team-a').category).toBe('destructive');
  });
});

describe('permissionService.filterClusters', () => {
  const clusters = [
    { name: 'prod',    namespaces: ['team-a', 'team-b'] },
    { name: 'staging', namespaces: ['team-a'] },
  ];

  it('returns everything unfiltered for a wildcard-cluster permission', () => {
    const perms = [{ cluster: '*', namespace: '*', role: 'admin' }];
    expect(filterClusters(perms, clusters)).toEqual(clusters);
  });

  it('returns no clusters for an empty permission set', () => {
    expect(filterClusters([], clusters)).toEqual([]);
  });

  it('trims namespaces down to only what is explicitly granted', () => {
    const perms = [{ cluster: 'prod', namespace: 'team-a', role: 'viewer' }];
    const result = filterClusters(perms, clusters);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('prod');
    expect(result[0].namespaces).toEqual(['team-a']);
  });

  it('excludes clusters the user has no permission entry for at all', () => {
    const perms = [{ cluster: 'staging', namespace: '*', role: 'viewer' }];
    const result = filterClusters(perms, clusters);
    expect(result.map(c => c.name)).toEqual(['staging']);
  });
});

describe('permissionService.getEligibleRecipients', () => {
  it('always includes admins, regardless of any permission grant', async () => {
    const models = fakeModels([{ _id: 'admin-1', role: 'admin', permissions: [], group: null }]);
    const targets = await getEligibleRecipients('prod', 'team-a', 'read-only', models);
    expect(targets).toEqual(['admin-1']);
  });

  it('includes a developer only if their own permissions grant access to the resource', async () => {
    const models = fakeModels([
      { _id: 'dev-with-access',    role: 'developer', permissions: [{ cluster: 'prod', namespace: 'team-a', role: 'viewer' }], group: null },
      { _id: 'dev-without-access', role: 'developer', permissions: [{ cluster: 'prod', namespace: 'team-b', role: 'admin' }],  group: null },
    ]);
    const targets = await getEligibleRecipients('prod', 'team-a', 'read-only', models);
    expect(targets).toEqual(['dev-with-access']);
  });

  it('includes a developer whose access comes from their group, not their own grants', async () => {
    const models = fakeModels(
      [{ _id: 'dev-1', role: 'developer', permissions: [], group: 'group-a' }],
      [{ _id: 'group-a', permissions: [{ cluster: 'prod', namespace: '*', role: 'viewer' }] }]
    );
    const targets = await getEligibleRecipients('prod', 'team-a', 'read-only', models);
    expect(targets).toEqual(['dev-1']);
  });

  it('excludes developers with no matching grant at all', async () => {
    const models = fakeModels([
      { _id: 'dev-1', role: 'developer', permissions: [{ cluster: 'staging', namespace: '*', role: 'admin' }], group: null },
    ]);
    const targets = await getEligibleRecipients('prod', 'team-a', 'read-only', models);
    expect(targets).toEqual([]);
  });

  it('supports cluster-scoped resources (namespace=null) — requires a cluster-wide grant', async () => {
    const models = fakeModels([
      { _id: 'dev-scoped',  role: 'developer', permissions: [{ cluster: 'prod', namespace: 'team-a', role: 'admin' }], group: null },
      { _id: 'dev-cluster', role: 'developer', permissions: [{ cluster: 'prod', namespace: '*',       role: 'viewer' }], group: null },
    ]);
    const targets = await getEligibleRecipients('prod', null, 'read-only', models);
    // dev-scoped's namespace-only grant must not qualify for a cluster-scoped notification —
    // same invariant as the H1 fix in checkAccess().
    expect(targets).toEqual(['dev-cluster']);
  });
});
