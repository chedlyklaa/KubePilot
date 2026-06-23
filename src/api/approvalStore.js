const TIMEOUT_MS    = 10 * 60 * 1000;
const notifEngine   = require('../services/notifications/engine');

let seq = 0;
const pending   = new Map();
const listeners = new Set();

function notify(event) { listeners.forEach(fn => fn(event)); }

function requestApproval(payload) {
  const id = String(++seq);

  notifEngine.emit({
    severity:   'CRITICAL',
    category:   'Agent Actions',
    title:      `Approval Required: ${payload.issueKey}`,
    message:    `High-risk action "${payload.diagnosis?.action}" needs approval. Risk: ${payload.diagnosis?.risk}. Cause: ${payload.diagnosis?.rootCause ?? '—'}`,
    namespace:  payload.issue?.namespace,
    source:     `ClusterAgent/${payload.issue?.clusterName ?? '—'}`,
    metadata:   { issueKey: payload.issueKey, action: payload.diagnosis?.action, risk: payload.diagnosis?.risk },
    targetRole: 'admin', // email only goes to users with role=admin
  }).catch(() => {});

  return new Promise(resolve => {
    const timer = setTimeout(async () => {
      if (!pending.has(id)) return;
      const entry = pending.get(id);
      pending.delete(id);
      notify({ type: 'resolved', id, decision: 'timeout' });
      await _saveHistory(entry, 'timeout', null);
      resolve(false);
    }, TIMEOUT_MS);

    pending.set(id, { id, payload, resolve, createdAt: new Date().toISOString(), timer });
    notify({ type: 'added', approval: { id, payload, createdAt: new Date().toISOString() } });
  });
}

async function _settle(id, approved, user, overrideData = {}, decision = null) {
  const entry = pending.get(id);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pending.delete(id);
  const resolvedDecision = decision ?? (approved ? 'approved' : 'denied');
  notify({ type: 'resolved', id, decision: resolvedDecision });
  entry.resolve(approved);
  await _saveHistory(entry, resolvedDecision, user, overrideData);
  return true;
}

async function _saveHistory(entry, decision, user, overrideData = {}) {
  try {
    const { ApprovalHistory } = require('../db/models');
    const doc = {
      issueKey:    entry.payload.issueKey,
      issue:       entry.payload.issue,
      diagnosis:   entry.payload.diagnosis,
      decision,
      decidedBy:   user ? { userId: user.id, name: user.name, email: user.email, role: user.role } : null,
      requestedAt: new Date(entry.createdAt),
    };
    if (overrideData.overrideReasons?.length) doc.overrideReasons = overrideData.overrideReasons;
    if (overrideData.preferredAction)          doc.preferredAction  = overrideData.preferredAction;
    if (overrideData.adminNote)                doc.adminNote        = overrideData.adminNote;
    await ApprovalHistory.create(doc);
  } catch (err) {
    console.error('[ApprovalStore] DB save failed:', err.message);
  }
  // Make override feedback available to ReflectionAgent when the episode is later stored
  if (decision === 'denied' && (overrideData.overrideReasons?.length || overrideData.preferredAction)) {
    const overrideStore = require('./overrideStore');
    overrideStore.set(entry.payload.issueKey, overrideData);
  }
}

const approve = (id, user)                      => _settle(id, true,  user, {});
const deny    = (id, user, overrideData = {})   => _settle(id, false, user, overrideData);
const silence = (id, user)                      => _settle(id, false, user, {}, 'silenced');

function getPending() {
  return [...pending.values()].map(({ id, payload, createdAt }) => ({ id, payload, createdAt }));
}

function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

module.exports = { requestApproval, approve, deny, silence, getPending, subscribe };
