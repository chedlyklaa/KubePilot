'use strict';

const { User, Group } = require('../db/models');

const ROLE_RANK = { viewer: 0, editor: 1, admin: 2 };

const CATEGORY_MIN_ROLE = {
  'read-only':       'viewer',
  'rolling-update':  'editor',
  'scaling':         'editor',
  'config-change':   'editor',
  'destructive':     'admin',
};

const VERB_CATEGORY = {
  get: 'read-only', describe: 'read-only', logs: 'read-only', top: 'read-only', explain: 'read-only',
  scale: 'scaling',
  'rollout restart': 'rolling-update', 'rollout undo': 'rolling-update',
  set: 'config-change', label: 'config-change', annotate: 'config-change',
  apply: 'config-change', patch: 'config-change', edit: 'config-change',
  create: 'config-change', run: 'config-change', expose: 'config-change',
  delete: 'destructive', drain: 'destructive', cordon: 'destructive', uncordon: 'config-change',
  taint: 'destructive', exec: 'config-change', cp: 'config-change',
};

const _SORTED_VERBS = Object.entries(VERB_CATEGORY).sort((a, b) => b[0].length - a[0].length);

const _GLOBAL_FLAG_RE = /(?:--context|--namespace|-n|--as|--as-group)[= ]\S+/g;

function classifyCommand(command) {
  const trimmed = command
    .replace(/^kubectl\s+/, '')
    .replace(_GLOBAL_FLAG_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (const [verb, cat] of _SORTED_VERBS) {
    if (trimmed.startsWith(verb)) return cat;
  }
  return 'destructive';
}

function _stripQuotes(s) { return s ? s.replace(/^["']|["']$/g, '') : null; }

function parseCommandScope(command) {
  const ctxMatch = command.match(/--context[= ](\S+)/);
  const nsMatch  = command.match(/(?:-n|--namespace)[= ](\S+)/);
  return {
    cluster:   _stripQuotes(ctxMatch?.[1] ?? null),
    namespace: _stripQuotes(nsMatch?.[1]  ?? null),
    category:  classifyCommand(command),
  };
}

// Load the effective permissions of a user
async function loadPermissions(userId) {
  const user = await User.findById(userId).lean();
  if (!user) return [];

  let perms = [...(user.permissions ?? [])];

  if (user.group) {
    const group = await Group.findById(user.group).lean();
    if (group?.permissions?.length) {
      perms = perms.concat(group.permissions);
    }
  }
  return perms;
}

// Get the users to notify for a cluster and namespace
async function getEligibleRecipients(cluster, namespace, category = 'read-only', models = {}) {
  const UserModel  = models.User  ?? User;
  const GroupModel = models.Group ?? Group;

  const users = await UserModel.find({ active: { $ne: false } }).select('_id role permissions group').lean();

  const groupIds = [...new Set(users.filter(u => u.group).map(u => u.group.toString()))];
  const groups   = groupIds.length
    ? await GroupModel.find({ _id: { $in: groupIds } }).select('_id permissions').lean()
    : [];
  const groupById = new Map(groups.map(g => [g._id.toString(), g]));

  const targets = [];
  for (const u of users) {
    if (u.role === 'admin') { targets.push(u._id.toString()); continue; }

    let perms = [...(u.permissions ?? [])];
    if (u.group) {
      const group = groupById.get(u.group.toString());
      if (group?.permissions?.length) perms = perms.concat(group.permissions);
    }
    if (checkAccess(perms, cluster, namespace, category)) targets.push(u._id.toString());
  }
  return targets;
}

// Check if permissions grant access
function checkAccess(permissions, cluster, namespace, category) {
  const minRole = CATEGORY_MIN_ROLE[category] ?? 'admin';
  const minRank = ROLE_RANK[minRole] ?? 2;

  for (const p of permissions) {
    const clusterOk   = p.cluster === '*' || p.cluster === cluster;
    const namespaceOk = namespace ? (p.namespace === '*' || p.namespace === namespace) : p.namespace === '*';
    const roleOk      = (ROLE_RANK[p.role] ?? 0) >= minRank;
    if (clusterOk && namespaceOk && roleOk) return true;
  }
  return false;
}

// Filter clusters by user permissions
function filterClusters(permissions, clusters) {
  if (!permissions?.length) return [];
  const hasWild = permissions.some(p => p.cluster === '*');
  if (hasWild) return clusters;

  const allowed = new Map();
  for (const p of permissions) {
    if (!allowed.has(p.cluster)) allowed.set(p.cluster, new Set());
    if (p.namespace === '*') allowed.get(p.cluster).add('*');
    else allowed.get(p.cluster).add(p.namespace);
  }

  return clusters
    .filter(c => allowed.has(c.name))
    .map(c => {
      const nsSet = allowed.get(c.name);
      if (nsSet.has('*')) return c;
      const clusterNs = c.namespaces ?? ['default'];
      if (clusterNs.includes('*')) return { ...c, namespaces: [...nsSet] };
      return { ...c, namespaces: clusterNs.filter(ns => nsSet.has(ns)) };
    })
    .filter(c => c.namespaces?.length > 0);
}

// Describe the user's scope for the prompt
function describeScope(permissions) {
  if (!permissions?.length) return 'You have NO permissions. Reject all kubectl requests and tell the user to ask their admin for access.';
  if (permissions.some(p => p.cluster === '*' && p.namespace === '*' && p.role === 'admin'))
    return 'You have FULL ADMIN access to all clusters and namespaces.';

  const lines = permissions.map(p =>
    `- cluster="${p.cluster}" namespace="${p.namespace}" role=${p.role}`
  );
  return `The operator's access scope:\n${lines.join('\n')}\n\n` +
    'SCOPE RULES:\n' +
    '- viewer: read-only commands only (get, describe, logs)\n' +
    '- editor: read + write (scale, restart, set image, apply, create) — but NOT delete, drain, taint\n' +
    '- admin: full access including destructive operations\n' +
    'If the requested operation is outside the operator\'s scope, refuse and explain what access they need.';
}

module.exports = {
  loadPermissions,
  getEligibleRecipients,
  checkAccess,
  filterClusters,
  describeScope,
  classifyCommand,
  parseCommandScope,
  ROLE_RANK,
  CATEGORY_MIN_ROLE,
};
