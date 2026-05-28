// Escalation store — in-memory active escalations + MongoDB persistence.
// Lifecycle: pending → acknowledged → in_progress → fixed | not_fixed | need_help

const teams = require('../notifications/Teams');

let seq = 0;
const escalations = new Map();
const listeners   = new Set();

function _notify(event)    { listeners.forEach(fn => fn(event)); }
function _safe(entry)      { const { mongoId, resolve, ...rest } = entry; return rest; }
function _sanitize(issue)  { const { logs, env, secrets, ...safe } = issue ?? {}; return safe; }

async function _getAdminIds() {
  try {
    const { User } = require('../db/models');
    const admins = await User.find({ role: 'admin', active: true }).select('_id');
    return admins.map(a => a._id.toString());
  } catch { return []; }
}

// ── Escalate (called by agent) ────────────────────────────────────────────────
async function escalate(issueKey, issue, history) {
  const id    = String(++seq);
  const entry = {
    id, issueKey,
    issue:              _sanitize(issue),
    history,
    attempts:           history.length,
    status:             'pending',
    createdAt:          new Date().toISOString(),
    assignedTo:         null,
    reassignRequested:  false,
    mongoId:            null,
  };

  try {
    const { EscalationHistory } = require('../db/models');
    const doc = await EscalationHistory.create({
      issueKey,
      issue:         entry.issue,
      attempts:      history.length,
      failedHistory: history,
      status:        'pending',
    });
    entry.mongoId = doc._id.toString();
  } catch (err) {
    console.error('[EscalationStore] DB save failed:', err.message);
  }

  escalations.set(id, entry);
  _notify({ type: 'added', escalation: _safe(entry) });

  // Notify general Teams channel so the whole team sees it
  teams.sendEscalation({
    issueKey:     issueKey,
    cluster:      issue?.clusterName,
    namespace:    issue?.namespace,
    type:         issue?.type,
    attempts:     history.length,
    dashboardUrl: process.env.DASHBOARD_URL,
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
    const { EscalationHistory } = require('../db/models');
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

  const prev = entry.status;
  entry.status         = state;
  entry.stateUpdatedAt = new Date().toISOString();
  entry.stateUpdatedBy = { name: user.name, email: user.email, role: user.role };

  try {
    const { EscalationHistory } = require('../db/models');
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
    const notif  = require('./notificationStore');
    const adminIds = await _getAdminIds();
    const labels   = { fixed: '✓ marked as Fixed', need_help: '⚠ needs Help' };
    await notif.send(adminIds, {
      type:    state === 'fixed' ? 'success' : 'warn',
      message: `${user.name} ${labels[state]}: ${entry.issueKey}`,
      data:    { escalationId: id, issueKey: entry.issueKey },
    });
  }

  // Remove from active list when fixed
  if (state === 'fixed') {
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
    const { EscalationHistory } = require('../db/models');
    if (entry.mongoId) await EscalationHistory.findByIdAndUpdate(entry.mongoId, {
      assignedTo:          assignedTo,
      assignedAt:          new Date(),
      assignedBy:          { name: assignedBy.name, email: assignedBy.email },
      reassignRequested:   false,
    });
  } catch (err) {
    console.error('[EscalationStore] DB update failed:', err.message);
  }

  const notif = require('./notificationStore');

  // Notify new assignee
  await notif.send([assignedTo.userId], {
    type:    'warn',
    message: `📌 You have been assigned to handle: ${entry.issueKey}`,
    data:    { escalationId: id, issueKey: entry.issueKey, assignedBy: { name: assignedBy.name } },
  });

  // Notify old assignee if different
  if (oldAssignee?.userId && oldAssignee.userId !== assignedTo.userId) {
    await notif.send([oldAssignee.userId], {
      type:    'info',
      message: `↩ You have been removed from: ${entry.issueKey} (reassigned by ${assignedBy.name})`,
      data:    { escalationId: id, issueKey: entry.issueKey },
    });
  }

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
    const { EscalationHistory } = require('../db/models');
    if (entry.mongoId) await EscalationHistory.findByIdAndUpdate(entry.mongoId, {
      reassignRequested:   true,
      reassignRequestedAt: new Date(),
      reassignRequestedBy: entry.reassignRequestedBy,
    });
  } catch (err) {
    console.error('[EscalationStore] DB update failed:', err.message);
  }

  const notif    = require('./notificationStore');
  const adminIds = await _getAdminIds();
  await notif.send(adminIds, {
    type:    'warn',
    message: `🔄 ${user.name} is requesting reassignment for: ${entry.issueKey}`,
    data:    { escalationId: id, issueKey: entry.issueKey, requestedBy: { name: user.name, email: user.email } },
  });

  _notify({ type: 'updated', escalation: _safe(entry) });
  return true;
}

function getAll()      { return [...escalations.values()].map(_safe); }
function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

// ── Restore active escalations from MongoDB on startup ────────────────────────
async function init() {
  try {
    const { EscalationHistory } = require('../db/models');
    const docs = await EscalationHistory.find({ status: { $nin: ['fixed'] } }).sort({ escalatedAt: 1 });

    for (const doc of docs) {
      const id = String(++seq);
      escalations.set(id, {
        id,
        issueKey:            doc.issueKey,
        issue:               doc.issue ?? {},
        history:             doc.failedHistory ?? [],
        attempts:            doc.attempts ?? 0,
        status:              doc.status ?? 'pending',
        createdAt:           (doc.escalatedAt ?? doc.createdAt)?.toISOString(),
        assignedTo:          doc.assignedTo ?? null,
        assignedAt:          doc.assignedAt?.toISOString() ?? null,
        reassignRequested:   doc.reassignRequested ?? false,
        reassignRequestedBy: doc.reassignRequestedBy ?? null,
        stateUpdatedAt:      doc.stateUpdatedAt?.toISOString() ?? null,
        stateUpdatedBy:      doc.stateUpdatedBy ?? null,
        mongoId:             doc._id.toString(),
      });
    }

    if (docs.length > 0)
      console.log(`[EscalationStore] Restored ${docs.length} active escalation(s) from MongoDB`);
  } catch (err) {
    console.error('[EscalationStore] Failed to restore escalations:', err.message);
  }
}

module.exports = { init, escalate, acknowledge, updateState, assign, requestReassign, getAll, subscribe };
