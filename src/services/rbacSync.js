'use strict';

const yamlLib = require('js-yaml');
const fs      = require('fs');
const path    = require('path');
const kubectl = require('../tools/kubectl');
const { User, Group } = require('../db/models');
const permissionService = require('./permissionService');

const CONFIG_PATH = path.join(__dirname, '../../config/clusters.yaml');

// Platform role → built-in K8s ClusterRole
const K8S_ROLE = { viewer: 'view', editor: 'edit', admin: 'admin' };

// Reverse of K8S_ROLE, for pulling K8s bindings back into system permissions.
// Only these built-in ClusterRoles are recognized — a binding referencing a custom
// Role/ClusterRole (anything else) is skipped rather than guessed at.
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

// ── YAML builders ────────────────────────────────────────────────────────────

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

// ── Cleanup old kubepilot-managed bindings for a user in one cluster ─────────

async function _cleanup(email, context) {
  const safe  = _sanitize(email);
  const label = `app.kubernetes.io/managed-by=kubepilot,kubepilot.io/user=${safe}`;
  try { await kubectl.runCommand(`kubectl --context="${context}" delete clusterrolebinding -l "${label}" --ignore-not-found`); } catch {}
  try { await kubectl.runCommand(`kubectl --context="${context}" delete rolebinding -A -l "${label}" --ignore-not-found`); } catch {}
}

// ── Core sync: effective permissions → K8s RoleBindings ─────────────────────

async function syncUserToK8s(userId) {
  const user = await User.findById(userId).lean();
  if (!user) return [];

  // Admins get their full-access wildcard synthesized here too — the same wildcard
  // loadPerms middleware hands out for API purposes — since user.permissions is
  // normally empty for an admin account (their access comes from `role`, not stored
  // scopes). Without this, syncing an admin produces zero RoleBindings.
  const effective  = user.role === 'admin'
    ? [{ cluster: '*', namespace: '*', role: 'admin' }]
    : await permissionService.loadPermissions(userId);
  const contextMap = _getContextMap();

  // Group permissions by target cluster (expand '*' to all clusters)
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

      // Wildcard namespace → ClusterRoleBinding (take highest role)
      const wildcard = perms.filter(p => p.namespace === '*');
      if (wildcard.length) {
        const best = wildcard.reduce((a, b) =>
          (permissionService.ROLE_RANK[b.role] ?? 0) > (permissionService.ROLE_RANK[a.role] ?? 0) ? b : a);
        manifests.push(_clusterRoleBinding(user.email, K8S_ROLE[best.role]));
      }

      // Specific namespaces → RoleBinding per namespace (highest role per ns)
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

  // Cleanup clusters where user no longer has permissions
  for (const [cluster, ctx] of contextMap) {
    if (!byCluster.has(cluster)) {
      try { await _cleanup(user.email, ctx); } catch {}
    }
  }

  return results;
}

// Sync all members of a group (call after group permissions change)
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

// Remove all kubepilot-managed bindings for a user from all clusters
async function removeUserFromK8s(email) {
  const contextMap = _getContextMap();
  for (const [, ctx] of contextMap) {
    try { await _cleanup(email, ctx); } catch {}
  }
}

// ── Reverse sync: K8s RoleBindings/ClusterRoleBindings → system User.permissions ──
//
// Reads every RoleBinding/ClusterRoleBinding in one cluster, keeps only subjects of
// kind "User" bound to a recognized built-in ClusterRole (view/edit/admin/cluster-admin
// — the same set syncUserToK8s writes), and reconciles that into each matching system
// User's `permissions` array, scoped to this one cluster:
//   - a user with current bindings has their permission entries for THIS cluster
//     replaced with what's actually bound in K8s right now (their entries for other
//     clusters, and any '*' wildcard grant, are left untouched)
//   - a user who previously had entries for this cluster but has no binding anymore
//     has those stale entries removed
//   - a bound subject with no matching system User (by email) is reported, never
//     auto-created
async function syncFromK8s(context) {
  const contextMap  = _getContextMap();
  const clusterName = [...contextMap.entries()].find(([, ctx]) => ctx === context)?.[0];
  if (!clusterName) throw new Error(`Context "${context}" is not in monitored clusters`);

  const [roleBindings, clusterRoleBindings] = await Promise.all([
    kubectl.getRoleBindings('*', context),
    kubectl.getClusterRoleBindings(context),
  ]);

  // email → Map(namespaceKey → role), namespaceKey '*' meaning cluster-wide
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

  // Users who currently hold permission entries for this cluster but have no K8s
  // binding here anymore — their access was revoked in K8s, so drop the stale entries.
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

module.exports = { syncUserToK8s, syncGroupToK8s, removeUserFromK8s, syncFromK8s };
