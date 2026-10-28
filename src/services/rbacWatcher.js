'use strict';

const k8s           = require('@kubernetes/client-node');
const k8sClient      = require('../tools/k8sClient');
const clusterConfig  = require('../config/clusterConfig');
const { loadConfig } = require('../config');

const RECONNECT_DELAY_MS  = 5_000;
const AUTO_APPLY_DEBOUNCE_MS = 3_000;

const CRB_PATH = '/apis/rbac.authorization.k8s.io/v1/clusterrolebindings';
const RB_PATH  = '/apis/rbac.authorization.k8s.io/v1/rolebindings';

const _active = new Map();

const _pending = new Map();

const _multiSubject = new Map();

function _lazyPlatformRole() {
  return require('./rbacSync').PLATFORM_ROLE;
}

function _changeKey(kind, namespace, bindingName, email) {
  return `${kind}:${namespace ?? ''}:${bindingName}:${email.toLowerCase()}`;
}

function _pushPending(context, change) {
  if (!_pending.has(context)) _pending.set(context, new Map());
  _pending.get(context).set(_changeKey(change.bindingKind, change.namespace, change.bindingName, change.email), change);
}

// Get pending changes for a context
function getPending(context) {
  return [...(_pending.get(context)?.values() ?? [])].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

// Get and clear pending changes for a context
function takePending(context) {
  const list = getPending(context);
  _pending.delete(context);
  return list;
}

function _bindingKey(bindingKind, namespace, bindingName) {
  return `${bindingKind}:${namespace ?? ''}:${bindingName}`;
}

// Get bindings waiting for manual review
function getMultiSubjectAdvisories(context) {
  return [...(_multiSubject.get(context)?.values() ?? [])];
}

function _clearMultiSubject(context, bKey) {
  _multiSubject.get(context)?.delete(bKey);
}

function _upsertMultiSubject(context, bKey, advisory) {
  if (!_multiSubject.has(context)) _multiSubject.set(context, new Map());
  _multiSubject.get(context).set(bKey, advisory);
}

const _unmatchedBacklog = new Map();

function _upsertBacklog(email, entry) {
  const key = email.toLowerCase();
  if (!_unmatchedBacklog.has(key)) _unmatchedBacklog.set(key, new Map());
  _unmatchedBacklog.get(key).set(`${entry.cluster}:${entry.namespace}`, entry);
}

function _clearBacklogEntry(email, cluster, namespace) {
  _unmatchedBacklog.get(email.toLowerCase())?.delete(`${cluster}:${namespace}`);
}

// Record grants for unknown users
function recordUnmatchedBacklog(result) {
  for (const u of result.unmatched ?? []) {
    _upsertBacklog(u.email, {
      cluster: result.cluster, context: result.context, namespace: u.namespace,
      role: u.role, bindingName: u.bindingName, timestamp: new Date().toISOString(),
    });
  }
  for (const u of result.deletedUnmatched ?? []) {
    _clearBacklogEntry(u.email, result.cluster, u.namespace);
  }
}

// Get and clear the backlog for an email
function resolveBacklogForEmail(email) {
  const key    = email.toLowerCase();
  const scopes = [...(_unmatchedBacklog.get(key)?.values() ?? [])]
    .map(({ cluster, namespace, role }) => ({ cluster, namespace, role }));
  _unmatchedBacklog.delete(key);
  return scopes;
}

// Requeue changes that failed to apply
function requeueFailed(context, failed) {
  for (const f of failed) _pushPending(context, f);
  if (failed.length) _scheduleAutoApply(context);
}

// Get the backlog of unknown users
function getUnmatchedBacklog() {
  return [...(_unmatchedBacklog.entries())].map(([email, scopes]) => ({
    email,
    scopes: [...scopes.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
  }));
}

const _autoApplyTimers  = new Map();
const _autoApplyRunning = new Set();

function _scheduleAutoApply(context) {
  if (_autoApplyTimers.has(context)) return;
  const timer = setTimeout(() => {
    _autoApplyTimers.delete(context);
    _runAutoApply(context);
  }, AUTO_APPLY_DEBOUNCE_MS);
  _autoApplyTimers.set(context, timer);
}

async function _runAutoApply(context) {
  if (_autoApplyRunning.has(context)) {
    _scheduleAutoApply(context);
    return;
  }
  _autoApplyRunning.add(context);
  try {
    const rbacSync = require('./rbacSync');
    await rbacSync.applyAndNotify(context, { actor: { userId: 'system', userEmail: 'rbac-watch-auto-sync' } });
  } catch (err) {
    console.warn(`[RBAC-WATCH] ${context} auto-apply failed: ${err.message}`);
  } finally {
    _autoApplyRunning.delete(context);
  }
}

function _handleEvent(context, cluster, bindingKind, changeType, apiObj) {
  const PLATFORM_ROLE = _lazyPlatformRole();
  const roleName = apiObj?.roleRef?.name;
  const role = PLATFORM_ROLE[roleName?.toLowerCase()];
  if (!role) return;

  const namespace   = bindingKind === 'ClusterRoleBinding' ? '*' : (apiObj.metadata?.namespace ?? 'default');
  const bindingName = apiObj.metadata?.name ?? '(unknown)';
  const bKey        = _bindingKey(bindingKind, namespace, bindingName);
  const userSubjects = (apiObj.subjects ?? []).filter(s => s.kind === 'User' && s.name);

  if (changeType === 'DELETED') {
    _clearMultiSubject(context, bKey);
    for (const s of userSubjects) {
      _pushPending(context, {
        timestamp: new Date().toISOString(), changeType, email: s.name, role,
        namespace, bindingName, bindingKind, context, cluster,
      });
    }
    if (userSubjects.length) _scheduleAutoApply(context);
    return;
  }

  if (userSubjects.length > 1) {
    _upsertMultiSubject(context, bKey, {
      context, cluster, bindingKind, bindingName, namespace, role,
      k8sUsers:      userSubjects.map(s => s.name),
      lastEventType: changeType,
      lastSeenAt:    new Date().toISOString(),
    });
    return;
  }

  _clearMultiSubject(context, bKey);
  for (const s of userSubjects) {
    _pushPending(context, {
      timestamp: new Date().toISOString(), changeType, email: s.name, role,
      namespace, bindingName, bindingKind, context, cluster,
    });
  }
  if (userSubjects.length) _scheduleAutoApply(context);
}

function _watchKind(context, cluster, bindingKind, apiPath, entry) {
  const attempt = async () => {
    if (entry.stopped) return;
    try {
      const kc    = await k8sClient.getKubeConfig(context);
      const watch = new k8s.Watch(kc);
      const req   = await watch.watch(
        apiPath,
        {},
        (phase, apiObj) => {
          if (phase !== 'ADDED' && phase !== 'MODIFIED' && phase !== 'DELETED') return;
          try { _handleEvent(context, cluster, bindingKind, phase, apiObj); }
          catch (err) { console.warn(`[RBAC-WATCH] ${cluster} ${bindingKind} event handling failed: ${err.message}`); }
        },
        err => {
          if (entry.stopped) return;
          if (err) console.warn(`[RBAC-WATCH] ${cluster} ${bindingKind} watch ended: ${err.message} — reconnecting in ${RECONNECT_DELAY_MS / 1000}s`);
          setTimeout(attempt, RECONNECT_DELAY_MS);
        }
      );
      entry.reqs.set(bindingKind, req);
    } catch (err) {
      console.warn(`[RBAC-WATCH] ${cluster} ${bindingKind} failed to start: ${err.message} — retrying in ${RECONNECT_DELAY_MS / 1000}s`);
      if (!entry.stopped) setTimeout(attempt, RECONNECT_DELAY_MS);
    }
  };
  attempt();
}

function start(context, cluster) {
  if (_active.has(context)) return;
  const entry = { stopped: false, reqs: new Map(), cluster };
  _active.set(context, entry);
  _watchKind(context, cluster, 'ClusterRoleBinding', CRB_PATH, entry);
  _watchKind(context, cluster, 'RoleBinding',        RB_PATH,  entry);
  console.log(`[RBAC-WATCH] Watching RBAC bindings on "${cluster}" (${context})`);
}

function stop(context) {
  const entry = _active.get(context);
  if (!entry) return;
  entry.stopped = true;
  for (const req of entry.reqs.values()) {
    try { req.abort(); } catch { }
  }
  _active.delete(context);
  _pending.delete(context);
  _multiSubject.delete(context);
  const timer = _autoApplyTimers.get(context);
  if (timer) { clearTimeout(timer); _autoApplyTimers.delete(context); }
  console.log(`[RBAC-WATCH] Stopped watching "${entry.cluster}" (${context})`);
}

// Start or stop watches for the monitored clusters
function reconcile(clusters) {
  const desired = new Map(clusters.map(c => [c.context, c.name]));
  for (const context of [..._active.keys()]) {
    if (!desired.has(context)) stop(context);
  }
  for (const [context, cluster] of desired) {
    if (!_active.has(context)) start(context, cluster);
  }
}

function boot() {
  if (!loadConfig().RBAC_WATCH_ENABLED) return;
  reconcile(clusterConfig.getClusters());
  clusterConfig.onChange(reconcile);
  console.log('[BOOT] RBAC watch     : active (live ADDED/MODIFIED/DELETED tracking on RoleBindings/ClusterRoleBindings)');
}

module.exports = {
  boot, start, stop, reconcile, getPending, takePending, getMultiSubjectAdvisories,
  recordUnmatchedBacklog, resolveBacklogForEmail, getUnmatchedBacklog, requeueFailed,
};
