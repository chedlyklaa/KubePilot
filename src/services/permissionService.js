'use strict';

const { User, Group } = require('../db/models');

// Maps action categories (from LLM output / kubectl verb classification) to the
// minimum permission role needed.  Order matters: higher roles inherit lower ones.
const ROLE_RANK = { viewer: 0, editor: 1, admin: 2 };

const CATEGORY_MIN_ROLE = {
  'read-only':       'viewer',
  'rolling-update':  'editor',
  'scaling':         'editor',
  'config-change':   'editor',
  'destructive':     'admin',
};

// Classify a raw kubectl command into a category (used by /api/command/execute
// which doesn't have the LLM's category field).
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

// Sort longest verbs first so multi-word verbs ("rollout restart") match before single-word ones
const _SORTED_VERBS = Object.entries(VERB_CATEGORY).sort((a, b) => b[0].length - a[0].length);

function classifyCommand(command) {
  const trimmed = command.replace(/^kubectl\s+/, '').trim();
  for (const [verb, cat] of _SORTED_VERBS) {
    if (trimmed.startsWith(verb)) return cat;
  }
  return 'destructive'; // unknown → safest default
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

// Load effective permissions: user's own + group's, deduplicated.
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

// Does the permission set grant access?
function checkAccess(permissions, cluster, namespace, category) {
  const minRole = CATEGORY_MIN_ROLE[category] ?? 'admin';
  const minRank = ROLE_RANK[minRole] ?? 2;

  for (const p of permissions) {
    const clusterOk   = p.cluster === '*' || p.cluster === cluster;
    // namespace=null means cluster-scoped command (get nodes, cordon) — any permission on that cluster grants access
    // namespace=string means namespaced command — must match exactly or wildcard
    const namespaceOk = p.namespace === '*' || !namespace || (namespace && p.namespace === namespace);
    const roleOk      = (ROLE_RANK[p.role] ?? 0) >= minRank;
    if (clusterOk && namespaceOk && roleOk) return true;
  }
  return false;
}

// Filter a cluster list down to only what the user can see.
// Returns clusters with namespaces trimmed to allowed ones.
function filterClusters(permissions, clusters) {
  if (!permissions?.length) return [];
  const hasWild = permissions.some(p => p.cluster === '*');
  if (hasWild) return clusters;

  const allowed = new Map(); // cluster → Set<namespace>
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
      // When cluster config uses '*' (all namespaces), we can't filter by name —
      // substitute with the user's explicitly allowed namespaces instead
      if (clusterNs.includes('*')) return { ...c, namespaces: [...nsSet] };
      return { ...c, namespaces: clusterNs.filter(ns => nsSet.has(ns)) };
    })
    .filter(c => c.namespaces?.length > 0);
}

// Human-readable scope block injected into LLM system prompt.
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
  checkAccess,
  filterClusters,
  describeScope,
  classifyCommand,
  parseCommandScope,
  ROLE_RANK,
  CATEGORY_MIN_ROLE,
};
