'use strict';

const yamlLib = require('js-yaml');
const fs      = require('fs');
const path    = require('path');
const kubectl = require('../tools/kubectl');
const { User, Group } = require('../db/models');
const permissionService = require('./permissionService');

const CONFIG_PATH = path.join(__dirname, '../../config/clusters.yaml');

const K8S_ROLE = { viewer: 'view', editor: 'edit', admin: 'admin' };

const PLATFORM_ROLE = { view: 'viewer', edit: 'editor', admin: 'admin', 'cluster-admin': 'admin' };

function _sanitize(str) {
  return str.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
}

function _getContextMap() {
  try {
    const clusters = yamlLib.load(fs.readFileSync(CONFIG_PATH, 'utf8')).clusters ?? [];
    return new Map(clusters.map(c => [c.name, c.context]));
  } catch { return new Map(); }
}

// Build a ClusterRoleBinding YAML
function _clusterRoleBinding(email, k8sRole) {
  const safe = _sanitize(email);
  return {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'ClusterRoleBinding',
    metadata: {
      name: `kp-${safe}`,
      labels: { 'app.kubernetes.io/managed-by': 'kubepilot', 'kubepilot.io/user': safe },
    },
    roleRef:  { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: k8sRole },
    subjects: [{ apiGroup: 'rbac.authorization.k8s.io', kind: 'User', name: email }],
  };
}

function _roleBinding(email, namespace, k8sRole) {
  const safe = _sanitize(email);
  return {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'RoleBinding',
    metadata: {
      name: `kp-${safe}`,
      namespace,
      labels: { 'app.kubernetes.io/managed-by': 'kubepilot', 'kubepilot.io/user': safe },
    },
    roleRef:  { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: k8sRole },
    subjects: [{ apiGroup: 'rbac.authorization.k8s.io', kind: 'User', name: email }],
  };
}

// Remove old managed bindings for a user
async function _cleanup(email, context) {
  const safe  = _sanitize(email);
  const label = `app.kubernetes.io/managed-by=kubepilot,kubepilot.io/user=${safe}`;
  try { await kubectl.runCommand(`kubectl --context="${context}" delete clusterrolebinding -l "${label}" --ignore-not-found`); } catch {}
  try { await kubectl.runCommand(`kubectl --context="${context}" delete rolebinding -A -l "${label}" --ignore-not-found`); } catch {}
}

// Sync a user's permissions to Kubernetes
async function syncUserToK8s(userId) {
  const user = await User.findById(userId).lean();
  if (!user) return [];

  const effective  = user.role === 'admin'
    ? [{ cluster: '*', namespace: '*', role: 'admin' }]
    : await permissionService.loadPermissions(userId);
  const contextMap = _getContextMap();

  const byCluster = new Map();
  for (const p of effective) {
    const targets = p.cluster === '*' ? [...contextMap.keys()] : [p.cluster];
    for (const c of targets) {
      if (!byCluster.has(c)) byCluster.set(c, []);
      byCluster.get(c).push(p);
    }
  }

  const results = [];
  for (const [cluster, perms] of byCluster) {
    const ctx = contextMap.get(cluster);
    if (!ctx) continue;

    try {
      await _cleanup(user.email, ctx);

      const manifests = [];

      const wildcard = perms.filter(p => p.namespace === '*');
      if (wildcard.length) {
        const best = wildcard.reduce((a, b) =>
          (permissionService.ROLE_RANK[b.role] ?? 0) > (permissionService.ROLE_RANK[a.role] ?? 0) ? b : a);
        manifests.push(_clusterRoleBinding(user.email, K8S_ROLE[best.role]));
      }

      const nsMap = new Map();
      for (const p of perms.filter(q => q.namespace !== '*')) {
        const cur = nsMap.get(p.namespace);
        if (!cur || (permissionService.ROLE_RANK[p.role] ?? 0) > (permissionService.ROLE_RANK[cur.role] ?? 0))
          nsMap.set(p.namespace, p);
      }
      for (const [ns, p] of nsMap) {
        manifests.push(_roleBinding(user.email, ns, K8S_ROLE[p.role]));
      }

      if (manifests.length) {
        const yamlStr = manifests.map(m => yamlLib.dump(m)).join('---\n');
        await kubectl.applyManifest(yamlStr, ctx);
      }

      results.push({ cluster, status: 'synced', bindings: manifests.length });
      console.log(`[RBAC Sync] ${user.email} → ${cluster}: ${manifests.length} binding(s) applied`);
    } catch (err) {
      results.push({ cluster, status: 'failed', error: err.message });
      console.warn(`[RBAC Sync] ${user.email} → ${cluster} FAILED: ${err.message}`);
    }
  }

  for (const [cluster, ctx] of contextMap) {
    if (!byCluster.has(cluster)) {
      try { await _cleanup(user.email, ctx); } catch {}
    }
  }

  return results;
}

// Sync all members of a group
async function syncGroupToK8s(groupId) {
  const members = await User.find({ group: groupId }).lean();
  const results = [];
  for (const m of members) {
    try {
      const r = await syncUserToK8s(m._id);
      results.push({ user: m.email, sync: r });
    } catch (err) {
      results.push({ user: m.email, error: err.message });
    }
  }
  return results;
}

// Sync permissions from Kubernetes bindings
async function syncFromK8s(context) {
  const contextMap  = _getContextMap();
  const clusterName = [...contextMap.entries()].find(([, ctx]) => ctx === context)?.[0];
  if (!clusterName) throw new Error(`Context "${context}" is not in monitored clusters`);

  const [roleBindings, clusterRoleBindings] = await Promise.all([
    kubectl.getRoleBindings('*', context),
    kubectl.getClusterRoleBindings(context),
  ]);

  const byEmail = new Map();
  function _record(email, nsKey, k8sRoleName) {
    const role = PLATFORM_ROLE[k8sRoleName?.toLowerCase()];
    if (!role || !email) return;
    if (!byEmail.has(email)) byEmail.set(email, new Map());
    const nsMap = byEmail.get(email);
    const cur = nsMap.get(nsKey);
    if (!cur || (permissionService.ROLE_RANK[role] ?? 0) > (permissionService.ROLE_RANK[cur] ?? 0)) {
      nsMap.set(nsKey, role);
    }
  }

  for (const crb of clusterRoleBindings) {
    for (const s of crb.subjects ?? []) {
      if (s.kind === 'User') _record(s.name, '*', crb.roleRef?.name);
    }
  }
  for (const rb of roleBindings) {
    for (const s of rb.subjects ?? []) {
      if (s.kind === 'User') _record(s.name, rb.metadata?.namespace, rb.roleRef?.name);
    }
  }

  const results = { cluster: clusterName, updated: [], unmatched: [], cleared: [] };
  const touchedEmails = new Set([...byEmail.keys()].map(e => e.toLowerCase()));

  for (const [email, nsMap] of byEmail) {
    const derivedPerms = [...nsMap.entries()].map(([namespace, role]) => ({ cluster: clusterName, namespace, role }));
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) { results.unmatched.push({ email, permissions: derivedPerms }); continue; }
    user.permissions = [...(user.permissions ?? []).filter(p => p.cluster !== clusterName), ...derivedPerms];
    await user.save();
    results.updated.push({ email: user.email, permissions: derivedPerms });
  }

  const staleUsers = await User.find({ 'permissions.cluster': clusterName });
  for (const user of staleUsers) {
    if (touchedEmails.has(user.email.toLowerCase())) continue;
    const before = user.permissions.length;
    user.permissions = user.permissions.filter(p => p.cluster !== clusterName);
    if (user.permissions.length !== before) {
      await user.save();
      results.cleared.push({ email: user.email });
    }
  }

  return results;
}

// Apply queued RBAC changes
async function applyPendingChanges(context) {
  const contextMap  = _getContextMap();
  const clusterName = [...contextMap.entries()].find(([, ctx]) => ctx === context)?.[0];
  if (!clusterName) throw new Error(`Context "${context}" is not in monitored clusters`);

  const rbacWatcher = require('./rbacWatcher');
  const changes = rbacWatcher.takePending(context);

  const results = { cluster: clusterName, context, updated: [], unmatched: [], deleted: [], deletedUnmatched: [], failed: [] };

  for (const change of changes) {
    const { changeType, email, role, namespace, bindingName } = change;
    try {
      const user = await User.findOne({ email: email.toLowerCase() });

      if (changeType === 'ADDED' || changeType === 'MODIFIED') {
        if (!user) {
          results.unmatched.push({ email, role, namespace, bindingName, changeType });
          continue;
        }
        const others = (user.permissions ?? []).filter(p => !(p.cluster === clusterName && p.namespace === namespace));
        user.permissions = [...others, { cluster: clusterName, namespace, role }];
        await user.save();
        results.updated.push({ email: user.email, role, namespace, bindingName, changeType });
        continue;
      }

      if (!user) {
        results.deletedUnmatched.push({ email, role, namespace, bindingName });
        continue;
      }
      const before = user.permissions.length;
      user.permissions = (user.permissions ?? []).filter(p => !(p.cluster === clusterName && p.namespace === namespace));
      if (user.permissions.length !== before) {
        await user.save();
        results.deleted.push({ email: user.email, role, namespace, bindingName });
      } else {
        results.deletedUnmatched.push({ email, role, namespace, bindingName });
      }
    } catch (err) {
      results.failed.push({ ...change, error: err.message });
      console.warn(`[RBAC Sync] ${clusterName}: applying ${email} → ${role}@${namespace} failed: ${err.message}`);
    }
  }

  return results;
}

// Apply changes, log them and notify
async function applyAndNotify(context, { actor }) {
  const { RbacAuditLog } = require('../db/models');
  const notifEngine      = require('./notifications/engine');
  const rbacWatcher       = require('./rbacWatcher');

  const result = await applyPendingChanges(context);
  rbacWatcher.recordUnmatchedBacklog(result);
  if (result.failed.length) rbacWatcher.requeueFailed(context, result.failed);

  const needsAttention = result.unmatched.length + result.deletedUnmatched.length + result.failed.length;

  RbacAuditLog.create({
    userId: actor.userId, userEmail: actor.userEmail,
    action: 'apply', kind: 'UserPermissionsSync',
    name: `${result.updated.length} updated, ${result.deleted.length} deleted, ${needsAttention} unmatched`,
    context, timestamp: new Date(),
  }).catch(e => console.error('[RBAC Audit]', e.message));

  if (needsAttention > 0) {
    const lines = [
      ...result.unmatched.map(u => `+ ${u.email} → ${u.role} @ ${u.namespace} — no matching KubePilot account, add them manually`),
      ...result.deletedUnmatched.map(u => `- ${u.email} → ${u.role} @ ${u.namespace} — binding removed from K8s but no stored permission matched`),
      ...result.failed.map(u => `! ${u.email} → ${u.role} @ ${u.namespace} — failed to apply (${u.error}), retrying`),
    ];
    notifEngine.emit({
      severity: 'WARNING',
      category: 'RBAC Sync',
      title:    `RBAC sync on ${result.cluster}: ${needsAttention} change(s) need admin attention`,
      message:  lines.join('\n'),
      source:   'rbac-sync',
      metadata: result,
    }).catch(() => {});
  }
  if (result.updated.length > 0 || result.deleted.length > 0) {
    notifEngine.emit({
      severity: 'INFO',
      category: 'RBAC Sync',
      title:    `RBAC sync on ${result.cluster}: ${result.updated.length} updated, ${result.deleted.length} removed`,
      message:  `Applied ${result.updated.length} update(s) and ${result.deleted.length} removal(s) from queued K8s RBAC changes.`,
      source:   'rbac-sync',
      metadata: result,
    }).catch(() => {});
  }

  return result;
}

// Apply backlogged grants to a new user
async function applyBacklogToNewUser(user) {
  const rbacWatcher = require('./rbacWatcher');
  const scopes = rbacWatcher.resolveBacklogForEmail(user.email);
  if (!scopes.length) return null;

  user.permissions = [...(user.permissions ?? []), ...scopes];
  await user.save();

  const { RbacAuditLog } = require('../db/models');
  RbacAuditLog.create({
    userId: 'system', userEmail: 'rbac-watch-auto-sync',
    action: 'apply', kind: 'UserPermissionsSync',
    name: `backfilled ${scopes.length} grant(s) from K8s for new user ${user.email}`,
    context: scopes.map(s => s.cluster).join(','), timestamp: new Date(),
  }).catch(e => console.error('[RBAC Audit]', e.message));

  const notifEngine = require('./notifications/engine');
  notifEngine.emit({
    severity: 'INFO',
    category: 'RBAC Sync',
    title:    `New user ${user.email} auto-granted ${scopes.length} permission(s) from existing K8s RBAC`,
    message:  scopes.map(s => `${s.role} @ ${s.cluster}/${s.namespace}`).join('\n'),
    source:   'rbac-sync',
    metadata: { email: user.email, scopes },
  }).catch(() => {});

  return scopes;
}

// Get advisories for multi-subject bindings
async function getMultiSubjectAdvisories(context) {
  const rbacWatcher = require('./rbacWatcher');
  const raw = rbacWatcher.getMultiSubjectAdvisories(context);

  const results = [];
  for (const a of raw) {
    const dbUsers = await User.find({
      'permissions.cluster':   a.cluster,
      'permissions.namespace': a.namespace,
      'permissions.role':      a.role,
    }).select('email').lean();
    results.push({ ...a, dbUsers: dbUsers.map(u => u.email) });
  }
  return results;
}

module.exports = {
  syncUserToK8s, syncGroupToK8s, syncFromK8s, applyPendingChanges,
  applyAndNotify, applyBacklogToNewUser, getMultiSubjectAdvisories, PLATFORM_ROLE,
};
