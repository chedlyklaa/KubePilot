// Escalation store — in-memory active escalations + MongoDB persistence.
// Lifecycle: pending → acknowledged → in_progress → fixed | not_fixed | need_help

'use strict';

const notifEngine             = require('../services/notifications/engine');
const permissionService       = require('../services/permissionService');
const notificationStore       = require('./notificationStore');
const { EscalationHistory, User } = require('../db/models');
const { createPubSub }        = require('./pubsub');
const { restoreActiveRecords } = require('./restoreActiveRecords');

// Who should be notified about an escalation on this cluster/namespace: admins always,
// developers only if they actually have access to the affected resource. Falls back to
// admins-only on any lookup failure — an escalation should never go completely unseen.
// `deps` is an injectable seam for tests (pass fake getEligibleRecipients/getAdminIds) —
// defaults to the real permissionService lookup + real admin query in production.
async function _getEscalationTargets(cluster, namespace, deps = {}) {
  const getEligibleRecipients = deps.getEligibleRecipients ?? permissionService.getEligibleRecipients;
  const getAdminIds           = deps.getAdminIds ?? _getAdminIds;
  try {
    return await getEligibleRecipients(cluster, namespace, 'read-only');
  } catch (err) {
    console.error('[EscalationStore] Failed to resolve notification targets, falling back to admins:', err.message);
    return getAdminIds();
  }
}

let seq = 0;
const escalations = new Map();
const { notify: _notify, subscribe } = createPubSub();

function _safe(entry)      { const { mongoId, resolve, ...rest } = entry; return rest; }
function _sanitize(issue)  { const { logs, env, secrets, ...safe } = issue ?? {}; return safe; }

async function _getAdminIds() {
  try {
    const admins = await User.find({ role: 'admin', active: true }).select('_id');
    return admins.map(a => a._id.toString());
  } catch { return []; }
}

// ── Escalate (called by agent) ────────────────────────────────────────────────
// `deps` is an injectable seam for tests — see _getEscalationTargets above; also
// accepts deps.EscalationHistoryModel and deps.notifEngine to fake out Mongo/notification
// delivery without mocking require() (unreliable for CJS modules under Vitest).
async function escalate(issueKey, issue, history, rca = null, deps = {}) {
  const EscalationHistoryModel = deps.EscalationHistoryModel ?? EscalationHistory;
  const notifier               = deps.notifEngine ?? notifEngine;

  // Deduplication: if an active escalation already exists for this issueKey,
  // don't create a new record. Instead:
  //   - still pending  → leave it, nothing to do
  //   - acknowledged / in_progress → agent failed again, bump attempts and
  //     reset to pending so it re-appears in the Unclaimed queue
  const existing = [...escalations.values()].find(e => e.issueKey === issueKey);
  if (existing) {
    if (existing.status === 'pending') {
      console.warn(`[EscalationStore] Duplicate suppressed for "${issueKey}" — already pending (id=${existing.id})`);
      return existing.id;
    }
    // Re-surface as unclaimed so the team sees the agent is still failing.
    // Clear all ownership metadata so the item is truly unclaimed.
    existing.status              = 'pending';
    existing.attempts            = (existing.attempts ?? 0) + 1;
    existing.assignedTo          = null;
    existing.assignedAt          = null;
    existing.acknowledgedBy      = null;
    existing.acknowledgedAt      = null;
    existing.reassignRequested   = false;
    existing.createdAt           = new Date().toISOString();
    existing.stateUpdatedAt      = new Date().toISOString();
    console.warn(`[EscalationStore] Re-escalated "${issueKey}" (id=${existing.id}) — reset to pending after ${existing.attempts} total attempt(s)`);

    // C3: update failedHistory and rca so operators see the latest failure context
    const updatedHistory = [...(existing.history ?? []), ...history];
    existing.history = updatedHistory;
    if (rca) existing.rca = rca;

    try {
      if (existing.mongoId) await EscalationHistoryModel.findByIdAndUpdate(existing.mongoId, {
        status:        'pending',
        attempts:      existing.attempts,
        failedHistory: updatedHistory,
        rca:           existing.rca ?? null,
        assignedTo:    null,
        acknowledgedBy: null,
        acknowledgedAt: null,
        reassignRequested: false,
      });
    } catch {}
    _notify({ type: 'updated', escalation: _safe(existing) });

    // Rate-limit: skip if we notified channels for this entry less than 30 min ago.
    const now = Date.now();
    const lastNotif = existing._lastTeamsNotif ?? 0;
    if (now - lastNotif >= 30 * 60 * 1000) {
      const reRcaSummary = existing.rca?.suspected_cause ? `\n\nRoot Cause: ${existing.rca.suspected_cause} (confidence: ${existing.rca.confidence ?? '?'})` : '';
      const reCluster    = existing.cluster || issue?.clusterName || '';
      const reNamespace  = existing.issue?.namespace ?? issue?.namespace;
      _getEscalationTargets(reCluster, reNamespace, deps).then(targetUserIds => notifier.emit({
        severity: 'CRITICAL',
        category: 'Incidents',
        title:    `Re-Escalated: ${issueKey}`,
        message:  `Agent failed again after ${existing.attempts} total attempt(s). Manual intervention still required.${reRcaSummary}`,
        namespace: reNamespace,
        source:   `ClusterAgent/${existing.issue?.clusterName ?? issue?.clusterName ?? '—'}`,
        metadata: { issueKey, attempts: existing.attempts, type: existing.issue?.type ?? issue?.type, rca: existing.rca ?? null },
        targetUserIds,
      })).then(() => {
        existing._lastTeamsNotif = Date.now();
        try {
          if (existing.mongoId)
            EscalationHistoryModel.findByIdAndUpdate(existing.mongoId, { lastTeamsNotif: new Date() }).catch(() => {});
        } catch {}
      }).catch(() => {});
    }

    return existing.id;
  }

  const id    = String(++seq);
  const cluster = issue?.clusterName ?? '';
  const node    = issue?.node ?? issue?.nodeName ?? '';
  const entry = {
    id, issueKey,
    issue:              _sanitize(issue),
    cluster,
    node,
    history,
    rca:                rca ?? null,
    attempts:           history.length,
    status:             'pending',
    createdAt:          new Date().toISOString(),
    assignedTo:         null,
    reassignRequested:  false,
    mongoId:            null,
  };

  try {
    const doc = await EscalationHistoryModel.create({
      issueKey,
      issue:         entry.issue,
      cluster,
      node,
      attempts:      history.length,
      failedHistory: history,
      rca:           rca ?? null,
      status:        'pending',
    });
    entry.mongoId = doc._id.toString();
  } catch (err) {
    console.error('[EscalationStore] DB save failed:', err.message);
  }

  escalations.set(id, entry);
  _notify({ type: 'added', escalation: _safe(entry) });

  const rcaSummary = rca?.suspected_cause ? `\n\nRoot Cause Analysis:\n• Suspected cause: ${rca.suspected_cause}\n• Confidence: ${rca.confidence ?? '?'}\n• Risk: ${rca.risk_level ?? '?'}\n• Focus: ${rca.recommended_focus ?? '—'}` : '';
  _getEscalationTargets(cluster, issue?.namespace, deps).then(targetUserIds => notifier.emit({
    severity: 'CRITICAL',
    category: 'Incidents',
    title:    `Escalation: ${issueKey}`,
    message:  `Agent exhausted ${history.length} attempt(s) without resolving the issue. Manual intervention required.${rcaSummary}`,
    namespace: issue?.namespace,
    source:   `ClusterAgent/${issue?.clusterName ?? '—'}`,
    metadata: { issueKey, attempts: history.length, type: issue?.type, rca: rca ?? null },
    targetUserIds,
  })).then(() => {
    entry._lastTeamsNotif = Date.now();
  }).catch(() => {});

  return id;
}

// ── Acknowledge (developer claims it) ────────────────────────────────────────
async function acknowledge(id, user) {
  const entry = escalations.get(id);
  if (!entry) return false;

  entry.status         = 'acknowledged';
  entry.acknowledgedBy = { userId: user.id, name: user.name, email: user.email, role: user.role };
  entry.acknowledgedAt = new Date().toISOString();
  entry.assignedTo     = { userId: user.id, name: user.name, email: user.email, role: user.role };
  entry.assignedAt     = entry.acknowledgedAt;

  try {
    if (entry.mongoId) await EscalationHistory.findByIdAndUpdate(entry.mongoId, {
      status:          'acknowledged',
      acknowledgedBy:  entry.acknowledgedBy,
      acknowledgedAt:  new Date(),
      assignedTo:      entry.assignedTo,
      assignedAt:      new Date(),
    });
  } catch (err) {
    console.error('[EscalationStore] DB update failed:', err.message);
  }

  _notify({ type: 'updated', escalation: _safe(entry) });
  return true;
}

// ── Update state ──────────────────────────────────────────────────────────────
async function updateState(id, state, user) {
  const entry = escalations.get(id);
  if (!entry) return false;

  entry.status         = state;
  entry.stateUpdatedAt = new Date().toISOString();
  entry.stateUpdatedBy = { name: user.name, email: user.email, role: user.role };

  try {
    if (entry.mongoId) await EscalationHistory.findByIdAndUpdate(entry.mongoId, {
      status:         state,
      stateUpdatedAt: new Date(),
      stateUpdatedBy: entry.stateUpdatedBy,
    });
  } catch (err) {
    console.error('[EscalationStore] DB update failed:', err.message);
  }

  // Notify admins when state is "fixed" or "need_help"
  if (state === 'fixed' || state === 'need_help') {
    const adminIds = await _getAdminIds();
    const labels   = { fixed: '✓ marked as Fixed', need_help: '⚠ needs Help' };
    await notificationStore.send(adminIds, {
      type:    state === 'fixed' ? 'success' : 'warn',
      message: `${user.name} ${labels[state]}: ${entry.issueKey}`,
      data:    { escalationId: id, issueKey: entry.issueKey },
    });
  }

  // Remove from active list when fixed or not_fixed (both are terminal outcomes).
  // need_help stays active so admins can see it and reassign.
  if (state === 'fixed' || state === 'not_fixed') {
    escalations.delete(id);
    _notify({ type: 'resolved', id });
  } else {
    _notify({ type: 'updated', escalation: _safe(entry) });
  }

  return true;
}

// ── Assign to user (admin only) ───────────────────────────────────────────────
async function assign(id, assignedTo, assignedBy) {
  const entry = escalations.get(id);
  if (!entry) return false;

  const oldAssignee   = entry.assignedTo;
  entry.assignedTo    = assignedTo;
  entry.assignedAt    = new Date().toISOString();
  entry.reassignRequested = false; // reset request after admin acts

  try {
    if (entry.mongoId) await EscalationHistory.findByIdAndUpdate(entry.mongoId, {
      assignedTo:          assignedTo,
      assignedAt:          new Date(),
      assignedBy:          { name: assignedBy.name, email: assignedBy.email },
      reassignRequested:   false,
    });
  } catch (err) {
    console.error('[EscalationStore] DB update failed:', err.message);
  }

  // Notify new assignee (in-app)
  await notificationStore.send([assignedTo.userId], {
    type:    'warn',
    message: `📌 You have been assigned to handle: ${entry.issueKey}`,
    data:    { escalationId: id, issueKey: entry.issueKey, assignedBy: { name: assignedBy.name } },
  });

  // Notify old assignee if different (in-app)
  if (oldAssignee?.userId && oldAssignee.userId !== assignedTo.userId) {
    await notificationStore.send([oldAssignee.userId], {
      type:    'info',
      message: `↩ You have been removed from: ${entry.issueKey} (reassigned by ${assignedBy.name})`,
      data:    { escalationId: id, issueKey: entry.issueKey },
    });
  }

  // Notify assignee via the notification engine (handles email delivery, retries, logging)
  notifEngine.emit({
    severity:      'WARNING',
    category:      'Incidents',
    title:         `Escalation assigned to you: ${entry.issueKey}`,
    message:       `You have been assigned to handle: ${entry.issueKey}` +
                   (assignedBy?.name ? ` (assigned by ${assignedBy.name})` : ''),
    source:        `EscalationStore`,
    metadata:      { escalationId: id, issueKey: entry.issueKey, assignedBy: { name: assignedBy.name } },
    targetUserIds: [assignedTo.userId],
  }).catch(() => {});

  _notify({ type: 'updated', escalation: _safe(entry) });
  return true;
}

// ── Developer requests reassignment ──────────────────────────────────────────
async function requestReassign(id, user) {
  const entry = escalations.get(id);
  if (!entry) return false;

  entry.reassignRequested    = true;
  entry.reassignRequestedAt  = new Date().toISOString();
  entry.reassignRequestedBy  = { name: user.name, email: user.email };

  try {
    if (entry.mongoId) await EscalationHistory.findByIdAndUpdate(entry.mongoId, {
      reassignRequested:   true,
      reassignRequestedAt: new Date(),
      reassignRequestedBy: entry.reassignRequestedBy,
    });
  } catch (err) {
    console.error('[EscalationStore] DB update failed:', err.message);
  }

  const adminIds = await _getAdminIds();
  await notificationStore.send(adminIds, {
    type:    'warn',
    message: `🔄 ${user.name} is requesting reassignment for: ${entry.issueKey}`,
    data:    { escalationId: id, issueKey: entry.issueKey, requestedBy: { name: user.name, email: user.email } },
  });

  _notify({ type: 'updated', escalation: _safe(entry) });
  return true;
}

async function remove(id) {
  const entry = escalations.get(id);
  if (!entry) return false;

  try {
    if (entry.mongoId) await EscalationHistory.findByIdAndDelete(entry.mongoId);
  } catch (err) {
    console.error('[EscalationStore] DB delete failed:', err.message);
  }

  escalations.delete(id);
  _notify({ type: 'resolved', id });
  return true;
}

function getAll() { return [...escalations.values()].map(_safe); }

// ── Restore active escalations from MongoDB on startup ────────────────────────
async function init() {
  try {
    // Exclude terminal statuses — fixed and not_fixed are done, no need to resurface them.
    const restored = await restoreActiveRecords(
      EscalationHistory,
      { status: { $nin: ['fixed', 'not_fixed'] } },
      () => String(++seq),
      (doc, id) => ({
        id,
        issueKey:            doc.issueKey,
        issue:               doc.issue ?? {},
        cluster:             doc.cluster ?? doc.issue?.clusterName ?? '',
        node:                doc.node ?? doc.issue?.node ?? doc.issue?.nodeName ?? '',
        history:             doc.failedHistory ?? [],
        rca:                 doc.rca ?? null,
        attempts:            doc.attempts ?? 0,
        status:              doc.status ?? 'pending',
        createdAt:           (doc.escalatedAt ?? doc.createdAt)?.toISOString(),
        assignedTo:          doc.assignedTo          ?? null,
        assignedAt:          doc.assignedAt?.toISOString()          ?? null,
        acknowledgedBy:      doc.acknowledgedBy       ?? null,
        acknowledgedAt:      doc.acknowledgedAt?.toISOString()       ?? null,
        reassignRequested:   doc.reassignRequested    ?? false,
        reassignRequestedBy: doc.reassignRequestedBy  ?? null,
        stateUpdatedAt:      doc.stateUpdatedAt?.toISOString()  ?? null,
        stateUpdatedBy:      doc.stateUpdatedBy       ?? null,
        mongoId:             doc._id.toString(),
        _lastTeamsNotif:     doc.lastTeamsNotif?.getTime()      ?? 0,
      })
    );

    // restoreActiveRecords doesn't sort — preserve the original escalatedAt-ascending order.
    restored.sort(([, a], [, b]) => new Date(a.createdAt ?? 0) - new Date(b.createdAt ?? 0));
    for (const [id, entry] of restored) escalations.set(id, entry);

    if (restored.length > 0)
      console.log(`[EscalationStore] Restored ${restored.length} active escalation(s) from MongoDB`);
  } catch (err) {
    console.error('[EscalationStore] Failed to restore escalations:', err.message);
  }
}

module.exports = { init, escalate, acknowledge, updateState, assign, requestReassign, remove, getAll, subscribe };
