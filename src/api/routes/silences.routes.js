'use strict';
const express = require('express');
const silenceStore = require('../silenceStore');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

router.get('/api/silences', requireAuth, requireAdmin, (_req, res) => {
  res.json(silenceStore.getAll());
});

router.post('/api/silences', requireAuth, requireAdmin, async (req, res) => {
  const { key, durationMs, reason } = req.body ?? {};
  if (!key || !durationMs) return res.status(400).json({ error: 'key and durationMs are required' });
  const entry = await silenceStore.add(key, Number(durationMs), reason ?? '', {
    name: req.user.name, email: req.user.email, role: req.user.role,
  });
  res.json(entry);
});

router.delete('/api/silences/:id', requireAuth, requireAdmin, async (req, res) => {
  const ok = await silenceStore.remove(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Silence not found' });
  res.json({ success: true });
});

module.exports = router;
