const TIMEOUT_MS = 10 * 60 * 1000;
const teams = require('../notifications/Teams');

let seq = 0;
const pending   = new Map();
const listeners = new Set();

function notify(event) { listeners.forEach(fn => fn(event)); }

function requestApproval(payload) {
  const id = String(++seq);

  // Notify admin Teams channel
  teams.sendApprovalRequest({
    issueKey:     payload.issueKey,
    action:       payload.diagnosis?.action,
    risk:         payload.diagnosis?.risk,
    cluster:      payload.issue?.clusterName,
    namespace:    payload.issue?.namespace,
    rootCause:    payload.diagnosis?.rootCause,
    dashboardUrl: process.env.DASHBOARD_URL,
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

async function _settle(id, approved, user) {
  const entry = pending.get(id);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pending.delete(id);
  const decision = approved ? 'approved' : 'denied';
  notify({ type: 'resolved', id, decision });
  entry.resolve(approved);
  await _saveHistory(entry, decision, user);
  return true;
}

async function _saveHistory(entry, decision, user) {
  try {
    const { ApprovalHistory } = require('../db/models');
    await ApprovalHistory.create({
      issueKey:    entry.payload.issueKey,
      issue:       entry.payload.issue,
      diagnosis:   entry.payload.diagnosis,
      decision,
      decidedBy:   user ? { name: user.name, email: user.email, role: user.role } : null,
      requestedAt: new Date(entry.createdAt),
    });
  } catch (err) {
    console.error('[ApprovalStore] DB save failed:', err.message);
  }
}

const approve = (id, user) => _settle(id, true,  user);
const deny    = (id, user) => _settle(id, false, user);

function getPending() {
  return [...pending.values()].map(({ id, payload, createdAt }) => ({ id, payload, createdAt }));
}

function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

module.exports = { requestApproval, approve, deny, getPending, subscribe };
