'use strict';
const express = require('express');
const liveWorkflowStore = require('../../monitoring/liveWorkflowStore');
const shortMemory = require('../../memory/shortMemory');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { sseHeaders, heartbeat } = require('../middleware/sse');

const router = express.Router();

router.get('/api/live-workflows', requireAuth, requireAdmin, (_req, res) => {
  res.json({ items: liveWorkflowStore.list() });
});

router.get('/api/live-workflows/stream', requireAuth, requireAdmin, (req, res) => {
  sseHeaders(res); heartbeat(req, res);
  const unsub = liveWorkflowStore.subscribe(e => res.write(`data: ${JSON.stringify(e)}\n\n`));
  req.on('close', unsub);
});

router.get('/api/live-workflows/short-memory', requireAuth, requireAdmin, async (_req, res) => {
  res.json(await shortMemory.dumpState());
});

module.exports = router;
