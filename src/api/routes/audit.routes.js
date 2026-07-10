'use strict';
const express = require('express');
const audit = require('../../audit/logger');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');

const router = express.Router();

// ── Audit log endpoint ────────────────────────────────────────────────────
router.get('/api/audit', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const limit   = Math.min(500, parseInt(req.query.limit  ?? '200', 10));
  const cluster = req.query.cluster  || null;
  const status  = req.query.status   || null;
  const agent   = req.query.agent    || null;
  const docs    = await audit.getLogsMongo({ limit, cluster, status, agent });
  res.json({ docs });
}));

module.exports = router;
