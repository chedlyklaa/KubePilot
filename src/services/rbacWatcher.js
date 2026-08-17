'use strict';

// Live Kubernetes Watch on RBAC bindings (ClusterRoleBindings + RoleBindings, all
// namespaces), one connection pair per monitored cluster. Replaces the sync button's
// old one-shot "kubectl get ... then diff everything" pull with an always-on feed:
// every ADDED/MODIFIED/DELETED event is normalized and queued here in memory, and
// POST /api/rbac/sync-from-k8s (via rbacSync.applyPendingChanges) just drains the
// queue instead of re-reading the whole cluster. Feature-flagged (RBAC_WATCH_ENABLED)
// like every other opt-in monitoring engine in this codebase — boot() is a no-op
// unless it's set.

const k8s           = require('@kubernetes/client-node');
const k8sClient      = require('../tools/k8sClient');
const clusterConfig  = require('../config/clusterConfig');
const { loadConfig } = require('../config');

const RECONNECT_DELAY_MS  = 5_000;
const AUTO_APPLY_DEBOUNCE_MS = 3_000;

const CRB_PATH = '/apis/rbac.authorization.k8s.io/v1/clusterrolebindings';
const RB_PATH  = '/apis/rbac.authorization.k8s.io/v1/rolebindings'; // unnamespaced path = all namespaces, same as `kubectl get rolebindings -A`

// context → { stopped, reqs: Map<kind, AbortController>, cluster }
const _active = new Map();

// context → Map<changeKey, change> — coalesced, latest event per (binding, subject)
// wins, so a burst of rapid edits before the next sync collapses into one entry
// instead of piling up duplicates for the same grant.
const _pending = new Map();

// context → Map<bindingKey, advisory> — bindings that currently have more than one
// User subject. These never enter `_pending`: if a binding lists 3 users and a
// MODIFIED event arrives showing 2, there's no way to tell from that alone whether
// someone was removed or never granted access in the first place (the watch gives us
// the new state, not a diff). Rather than guess, these are surfaced for an admin to
// compare against KubePilot's stored permissions by hand — see getMultiSubjectAdvisories.
const _multiSubject = new Map();

function _lazyPlatformRole() {
  // Lazy require: rbacSync.js requires this module (for applyPendingChanges), so
  // requiring rbacSync back at module-load time here would be circular.
  return require('./rbacSync').PLATFORM_ROLE;
}

function _changeKey(kind, namespace, bindingName, email) {
  return `${kind}:${namespace ?? ''}:${bindingName}:${email.toLowerCase()}`;
}

function _pushPending(context, change) {
  if (!_pending.has(context)) _pending.set(context, new Map());
  _pending.get(context).set(_changeKey(change.bindingKind, change.namespace, change.bindingName, change.email), change);
}

// Reads the current queue for a context without clearing it — used by the "pending
// changes" preview endpoint so the admin can see what a sync would do before running it.
function getPending(context) {
  return [...(_pending.get(context)?.values() ?? [])].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

// Reads AND clears the queue in one synchronous step (no `await` between the read and
// the delete, so a watch event arriving mid-call can't be silently dropped or double
// counted — it lands in the fresh Map created for anything queued after this returns).
function takePending(context) {
  const list = getPending(context);
  _pending.delete(context);
  return list;
}

function _bindingKey(bindingKind, namespace, bindingName) {
  return `${bindingKind}:${namespace ?? ''}:${bindingName}`;
}

// Read-only: bindings currently sitting in the manual-review queue for this context.
// The list of matching KubePilot-side users (dbUsers) is NOT resolved here — this
// module stays K8s-only/DB-free, same as the rest of it — see
// rbacSync.getMultiSubjectAdvisories, which enriches these with a Mongo lookup.
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

// email (lowercased) → Map<"cluster:namespace", {cluster, context, namespace, role,
// bindingName, timestamp}> — grants seen on the live cluster for an email with no
// matching KubePilot User yet. Auto-apply can't create the account (KubePilot never
// auto-creates users from cluster activity — see applyPendingChanges), so instead of
// dropping the grant on the floor it waits here until userService.create() calls
// resolveBacklogForEmail() for that email, which then backfills it in one shot.
const _unmatchedBacklog = new Map();

function _upsertBacklog(email, entry) {
  const key = email.toLowerCase();
  if (!_unmatchedBacklog.has(key)) _unmatchedBacklog.set(key, new Map());
  _unmatchedBacklog.get(key).set(`${entry.cluster}:${entry.namespace}`, entry);
}

function _clearBacklogEntry(email, cluster, namespace) {
  _unmatchedBacklog.get(email.toLowerCase())?.delete(`${cluster}:${namespace}`);
}

// Called by rbacSync.applyAndNotify (both the manual sync-from-k8s route and the
// auto-apply path below funnel through it) so an unmatched grant is remembered
// regardless of which path discovered it.
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

// Drains and returns every backlogged scope for one email, across all clusters —
// called once when that email is created as a KubePilot User.
function resolveBacklogForEmail(email) {
  const key    = email.toLowerCase();
  const scopes = [...(_unmatchedBacklog.get(key)?.values() ?? [])]
    .map(({ cluster, namespace, role }) => ({ cluster, namespace, role }));
  _unmatchedBacklog.delete(key);
  return scopes;
}

// Puts changes that failed to apply (e.g. a Mongoose optimistic-concurrency error from
// two overlapping auto-apply runs) back into the pending queue, so the next apply —
// auto or manual — retries them instead of them vanishing once takePending() already
// drained the original queue. Called from rbacSync.applyAndNotify.
function requeueFailed(context, failed) {
  for (const f of failed) _pushPending(context, f);
  if (failed.length) _scheduleAutoApply(context);
}

// Read-only: every email currently seen on a monitored cluster with no matching
// KubePilot User, grouped with all of its pending scopes — powers the "new users
// detected" panel so an admin has somewhere to actually see and act on what the
// auto-apply WARNING notification already told them about.
function getUnmatchedBacklog() {
  return [...(_unmatchedBacklog.entries())].map(([email, scopes]) => ({
    email,
    scopes: [...scopes.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
  }));
}

// context → Timeout — coalesces a burst of events (e.g. the relist a reconnect
// triggers) into a single applyAndNotify() call instead of one per event.
const _autoApplyTimers  = new Map();
// context → true while a run is in flight — a large batch (many users saved in a row)
// can take longer than the debounce window, and without this a second overlapping run
// can start and race the first one on the same User document (two concurrent .save()
// calls on the same doc trip Mongoose's optimistic-concurrency check and throw).
const _autoApplyRunning = new Set();

function _scheduleAutoApply(context) {
  if (_autoApplyTimers.has(context)) return; // already scheduled — it'll pick up everything queued by the time it fires
  const timer = setTimeout(() => {
    _autoApplyTimers.delete(context);
    _runAutoApply(context);
  }, AUTO_APPLY_DEBOUNCE_MS);
  _autoApplyTimers.set(context, timer);
}

async function _runAutoApply(context) {
  if (_autoApplyRunning.has(context)) {
    // A previous run is still applying a big batch — don't run concurrently, just
    // make sure another pass happens once it's done to pick up what arrived meanwhile.
    _scheduleAutoApply(context);
    return;
  }
  _autoApplyRunning.add(context);
  try {
    // Lazy require: rbacSync.js requires this module at load time — see the
    // circular-require comments elsewhere in this file.
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
  if (!role) return; // custom/unrecognized role — skip silently, same as syncFromK8s

  const namespace   = bindingKind === 'ClusterRoleBinding' ? '*' : (apiObj.metadata?.namespace ?? 'default');
  const bindingName = apiObj.metadata?.name ?? '(unknown)';
  const bKey        = _bindingKey(bindingKind, namespace, bindingName);
  const userSubjects = (apiObj.subjects ?? []).filter(s => s.kind === 'User' && s.name);

  // A binding disappearing entirely is unambiguous — every one of its subjects
  // definitely lost this grant, regardless of how many there were — so DELETEDs
  // always go through the normal auto-apply queue and clear any pending advisory.
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

  // ADDED / MODIFIED with more than one User subject: can't safely auto-diff, so
  // route the whole binding to manual review instead of the auto-apply queue.
  if (userSubjects.length > 1) {
    _upsertMultiSubject(context, bKey, {
      context, cluster, bindingKind, bindingName, namespace, role,
      k8sUsers:      userSubjects.map(s => s.name),
      lastEventType: changeType,
      lastSeenAt:    new Date().toISOString(),
    });
    return;
  }

  // Back down to 0 or 1 subjects — no longer ambiguous, drop any stale advisory
  // and process normally.
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
          if (phase !== 'ADDED' && phase !== 'MODIFIED' && phase !== 'DELETED') return; // ignore BOOKMARK/ERROR frames
          try { _handleEvent(context, cluster, bindingKind, phase, apiObj); }
          catch (err) { console.warn(`[RBAC-WATCH] ${cluster} ${bindingKind} event handling failed: ${err.message}`); }
        },
        err => {
          // "done" fires when the connection ends — server-side timeout, network
          // blip, or (if stop() was called) our own abort(). Reconnect unless stopped.
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
    try { req.abort(); } catch { /* already closed */ }
  }
  _active.delete(context);
  _pending.delete(context);
  _multiSubject.delete(context);
  const timer = _autoApplyTimers.get(context);
  if (timer) { clearTimeout(timer); _autoApplyTimers.delete(context); }
  console.log(`[RBAC-WATCH] Stopped watching "${entry.cluster}" (${context})`);
}

// Starts/stops watches so the active set matches the currently monitored clusters —
// called once at boot with the initial list, then again on every clusters.yaml change.
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
