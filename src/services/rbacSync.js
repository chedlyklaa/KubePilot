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

  const effective  = await permissionService.loadPermissions(userId);
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

module.exports = { syncUserToK8s, syncGroupToK8s, removeUserFromK8s };
