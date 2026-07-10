'use strict';
const express = require('express');
const escalationStore = require('../escalationStore');
const notificationStore = require('../notificationStore');
const permissionService = require('../../services/permissionService');
const { User, EscalationHistory } = require('../../db/models');
const { requireAuth, requireAdmin, loadPerms } = require('../middleware/auth');
const { sseHeaders, heartbeat } = require('../middleware/sse');

const router = express.Router();

// Same scope check used to decide who gets *notified* about an escalation
// (permissionService.getEligibleRecipients) — applied here so a user can't *see* or
// act on escalations for clusters/namespaces they don't have access to. loadPerms
// gives admins a wildcard permission entry, so checkAccess naturally passes for them.
function _inScope(req, entry) {
  return permissionService.checkAccess(req.permissions, entry.cluster, entry.issue?.namespace, 'read-only');
}

router.get('/api/escalations', requireAuth, loadPerms, (req, res) => {
  res.json(escalationStore.getAll().filter(e => _inScope(req, e)));
});
router.get('/api/escalations/stream', requireAuth, loadPerms, (req, res) => {
  sseHeaders(res); heartbeat(req, res);
  const initial = escalationStore.getAll().filter(e => _inScope(req, e));
  res.write(`data: ${JSON.stringify({ type: 'init', escalations: initial })}\n\n`);
  const unsub = escalationStore.subscribe(e => {
    // 'resolved' events only carry an id (no cluster/namespace) — harmless to forward
    // as-is, since a client that never saw the escalation just no-ops on the filter.
    if (e.escalation && !_inScope(req, e.escalation)) return;
    res.write(`data: ${JSON.stringify(e)}\n\n`);
  });
  req.on('close', unsub);
});

// Acknowledge (claim ownership)
router.post('/api/escalations/:id/acknowledge', requireAuth, loadPerms, async (req, res) => {
  const entry = escalationStore.getAll().find(e => e.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'Escalation not found' });
  if (!_inScope(req, entry)) return res.status(403).json({ error: 'You do not have access to this escalation' });
  res.json({ success: await escalationStore.acknowledge(req.params.id, req.user) });
});

// Update state (working | fixed | not_fixed | need_help)
router.put('/api/escalations/:id/state', requireAuth, loadPerms, async (req, res) => {
  const valid = new Set(['in_progress', 'fixed', 'not_fixed', 'need_help']);
  if (!valid.has(req.body.state)) return res.status(400).json({ error: 'Invalid state' });
  const entry = escalationStore.getAll().find(e => e.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'Escalation not found' });
  if (!_inScope(req, entry)) return res.status(403).json({ error: 'You do not have access to this escalation' });
  res.json({ success: await escalationStore.updateState(req.params.id, req.body.state, req.user) });
});

// Assign to user (admin only)
router.put('/api/escalations/:id/assign', requireAuth, requireAdmin, async (req, res) => {
  const target = await User.findById(req.body.userId);
  if (!target) return res.status(404).json({ error: 'User not found' });
  const assignedTo = { userId: target._id.toString(), name: target.name, email: target.email, role: target.role };
  res.json({ success: await escalationStore.assign(req.params.id, assignedTo, req.user) });
});

// Request reassignment (developer)
router.post('/api/escalations/:id/request-reassign', requireAuth, loadPerms, async (req, res) => {
  const entry = escalationStore.getAll().find(e => e.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'Escalation not found' });
  if (!_inScope(req, entry)) return res.status(403).json({ error: 'You do not have access to this escalation' });
  res.json({ success: await escalationStore.requestReassign(req.params.id, req.user) });
});

// Delete escalation (admin only)
router.delete('/api/escalations/:id', requireAuth, requireAdmin, async (req, res) => {
  const success = await escalationStore.remove(req.params.id);
  if (!success) return res.status(404).json({ error: 'Escalation not found' });
  res.json({ success: true });
});

// Reassign a historical escalation record (admin only)
router.put('/api/history/escalations/:id/assign', requireAuth, requireAdmin, async (req, res) => {
  const target = await User.findById(req.body.userId);
  if (!target) return res.status(404).json({ error: 'User not found' });
  const assignedTo = { userId: target._id.toString(), name: target.name, email: target.email, role: target.role };
  const doc = await EscalationHistory.findByIdAndUpdate(
    req.params.id,
    { assignedTo, assignedAt: new Date(), assignedBy: { name: req.user.name, email: req.user.email } },
    { new: true }
  );
  if (!doc) return res.status(404).json({ error: 'Record not found' });
  await notificationStore.send([target._id.toString()], {
    type: 'warn',
    message: `📌 You have been assigned to handle: ${doc.issueKey}`,
    data: { issueKey: doc.issueKey },
  });
  res.json({ success: true, assignedTo });
});

module.exports = router;
