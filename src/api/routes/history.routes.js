'use strict';
const express = require('express');
const { ApprovalHistory, EscalationHistory } = require('../../db/models');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/api/history/approvals', requireAuth, async (_req, res) => {
  res.json(await ApprovalHistory.find().sort({ createdAt: -1 }).limit(100));
});
router.get('/api/history/escalations', requireAuth, async (_req, res) => {
  res.json(await EscalationHistory.find().sort({ escalatedAt: -1 }).limit(100));
});

module.exports = router;
