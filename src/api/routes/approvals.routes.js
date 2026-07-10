'use strict';
const express = require('express');
const approvalStore = require('../approvalStore');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { sseHeaders, heartbeat } = require('../middleware/sse');

const router = express.Router();

router.get('/api/approvals', requireAuth, (_req, res) => res.json(approvalStore.getPending()));
router.get('/api/approvals/stream', requireAuth, (req, res) => {
  sseHeaders(res); heartbeat(req, res);
  res.write(`data: ${JSON.stringify({ type: 'init', approvals: approvalStore.getPending() })}\n\n`);
  const unsub = approvalStore.subscribe(e => res.write(`data: ${JSON.stringify(e)}\n\n`));
  req.on('close', unsub);
});
router.post('/api/approvals/:id/approve', requireAuth, requireAdmin, async (req, res) => {
  res.json({ success: await approvalStore.approve(req.params.id, req.user) });
});
router.post('/api/approvals/:id/deny', requireAuth, requireAdmin, async (req, res) => {
  const { overrideReasons, preferredAction, adminNote } = req.body ?? {};
  res.json({ success: await approvalStore.deny(req.params.id, req.user, { overrideReasons, preferredAction, adminNote }) });
});
router.post('/api/approvals/:id/silence', requireAuth, requireAdmin, async (req, res) => {
  res.json({ success: await approvalStore.silence(req.params.id, req.user) });
});

module.exports = router;
