'use strict';
const express = require('express');
const logStore = require('../logStore');
const { requireAuth } = require('../middleware/auth');
const { sseHeaders, heartbeat } = require('../middleware/sse');

const router = express.Router();

router.get('/api/logs', requireAuth, (_req, res) => res.json(logStore.getAll()));
router.get('/api/logs/stream', requireAuth, (req, res) => {
  sseHeaders(res); heartbeat(req, res);
  logStore.getAll().forEach(e => res.write(`data: ${JSON.stringify(e)}\n\n`));
  const unsub = logStore.subscribe(e => res.write(`data: ${JSON.stringify(e)}\n\n`));
  req.on('close', unsub);
});

module.exports = router;
