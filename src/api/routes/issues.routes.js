'use strict';
const express = require('express');
const issueTrackerStore = require('../issueTrackerStore');
const logStore           = require('../logStore');
const permissionService  = require('../../services/permissionService');
const { AuditEvent, ApprovalHistory, EscalationHistory } = require('../../db/models');
const { requireAuth, loadPerms } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { sseHeaders, heartbeat } = require('../middleware/sse');

const router = express.Router();

// Same scope rule as escalations — a user can only see issue-tracking data for
// clusters/namespaces they actually have access to.
function _inScope(req, item) {
  return permissionService.checkAccess(req.permissions, item.cluster, item.namespace, 'read-only');
}

// ── List (paginated, filterable by status/cluster) ───────────────────────────
router.get('/api/issues', requireAuth, loadPerms, asyncHandler(async (req, res) => {
  const status = req.query.status  || null;
  const cluster = req.query.cluster || null;
  const page  = Math.max(1, parseInt(req.query.page ?? '1', 10));
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit ?? '25', 10)));

  // Scope filtering happens in JS (permission grants aren't expressible as a single
  // Mongo query), so pull a generous batch before paginating — mirrors how
  // escalationStore's getAll().filter(_inScope) works, just with a page carved out.
  const { items } = await issueTrackerStore.list({ status, cluster, limit: 500, skip: 0 });
  const scoped = items.filter(it => _inScope(req, it));
  const start  = (page - 1) * limit;

  res.json({ items: scoped.slice(start, start + limit), total: scoped.length, page, limit });
}));

// ── Live updates (SSE) — new detections and stage transitions while the page is open ──
router.get('/api/issues/stream', requireAuth, loadPerms, (req, res) => {
  sseHeaders(res); heartbeat(req, res);
  const unsub = issueTrackerStore.subscribe(e => {
    if (e.issue && !_inScope(req, e.issue)) return;
    res.write(`data: ${JSON.stringify(e)}\n\n`);
  });
  req.on('close', unsub);
});

// ── Detail — full timeline plus everything correlated by issueKey ────────────
router.get('/api/issues/:id', requireAuth, loadPerms, asyncHandler(async (req, res) => {
  const record = await issueTrackerStore.getBySeq(req.params.id);
  if (!record) return res.status(404).json({ error: 'Issue not found' });
  if (!_inScope(req, record)) return res.status(403).json({ error: 'You do not have access to this issue' });

  const [auditEvents, approvals, escalations] = await Promise.all([
    AuditEvent.find({ 'metadata.issueKey': record.issueKey }).sort({ timestamp: 1 }).limit(200).lean().catch(() => []),
    ApprovalHistory.find({ issueKey: record.issueKey }).sort({ createdAt: 1 }).lean().catch(() => []),
    EscalationHistory.find({ issueKey: record.issueKey }).sort({ createdAt: 1 }).lean().catch(() => []),
  ]);

  // Best-effort correlation with raw console logs. The ring buffer has no structured
  // issueKey field, so this matches on the issueKey/resource substring within the
  // episode's time window — approximate by design (clusterAgent's own log lines embed
  // the key almost everywhere, e.g. "[SKIP] type:target:ns"). The structured timeline
  // and audit trail above are the reliable sources; this is supplementary color.
  const needle = (record.issueKey || record.resource || '').toLowerCase();
  const windowStart = new Date(record.createdAt).getTime();
  const windowEnd   = (record.resolvedAt ? new Date(record.resolvedAt).getTime() : Date.now()) + 60_000;
  const relatedLogs = needle
    ? logStore.getAll().filter(l => {
        const t = new Date(l.timestamp).getTime();
        return t >= windowStart && t <= windowEnd && l.message.toLowerCase().includes(needle);
      }).slice(-200)
    : [];

  res.json({ ...record, auditEvents, approvals, escalations, relatedLogs });
}));

module.exports = router;
