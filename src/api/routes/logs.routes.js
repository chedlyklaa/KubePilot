'use strict';
const express = require('express');
const logStore = require('../logStore');
const { requireAuth } = require('../middleware/auth');
const { sseHeaders, heartbeat } = require('../middleware/sse');

const router = express.Router();

router.get('/api/logs', requireAuth, (_req, res) => res.json(logStore.getAll()));
router.get('/api/logs/stream', requireAuth, (req, res) => {
  sseHeaders(res); heartbeat(req, res);
  // Replay the backlog as a single batch, not one message per entry — with up to
  // 1000 buffered lines, one-message-per-entry meant 1000 separate client state
  // updates (and re-renders) on every page visit. Mirrors the init-batch pattern
  // already used by the approvals/escalations streams.
  res.write(`data: ${JSON.stringify({ type: 'init', logs: logStore.getAll() })}\n\n`);
  const unsub = logStore.subscribe(e => res.write(`data: ${JSON.stringify({ type: 'log', entry: e })}\n\n`));
  req.on('close', unsub);
});

module.exports = router;
