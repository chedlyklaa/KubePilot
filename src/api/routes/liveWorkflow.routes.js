'use strict';
const express = require('express');
const liveWorkflowStore = require('../../monitoring/liveWorkflowStore');
const shortMemory = require('../../memory/shortMemory');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { sseHeaders, heartbeat } = require('../middleware/sse');

const router = express.Router();

// Admin-only: this is a raw, unfiltered view of every component's reasoning (exact
// kubectl commands, guardian rationale, policy verdicts) across the WHOLE fleet, with
// no per-cluster/namespace scoping the way /api/issues has — not appropriate to expose
// to a scoped non-admin user.

// ── List — every incident currently in flight or recently finished ───────────
router.get('/api/live-workflows', requireAuth, requireAdmin, (_req, res) => {
  res.json({ items: liveWorkflowStore.list() });
});

// ── Live updates (SSE) — new steps as the pipeline actually runs ─────────────
// Each event carries the FULL incident record (not just an id) — same upsert-by-id
// pattern as /api/issues/stream — so the page never needs a separate per-row detail
// fetch; incidentKey can contain "/" (see src/orchestrator/issueKey.js), which would
// be awkward as a path param anyway.
router.get('/api/live-workflows/stream', requireAuth, requireAdmin, (req, res) => {
  sseHeaders(res); heartbeat(req, res);
  const unsub = liveWorkflowStore.subscribe(e => res.write(`data: ${JSON.stringify(e)}\n\n`));
  req.on('close', unsub);
});

// ── Short Memory dump — everything currently held in Redis (queue, active-workflow
// set, per-resource locks/attempts/cooldowns, group membership) for the same debugging
// purpose as the workflow table above, just one layer lower — this is the dispatch
// state driving WHICH incidents get turned into workflows at all, not the workflows
// themselves. Read-only, computed fresh on every call (no caching) — see
// shortMemory.dumpState() for the SCAN-based, best-effort implementation.
router.get('/api/live-workflows/short-memory', requireAuth, requireAdmin, async (_req, res) => {
  res.json(await shortMemory.dumpState());
});

module.exports = router;
