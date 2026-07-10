'use strict';
const express = require('express');
const metricsCollector = require('../../monitoring/metricsCollector');
const vectorStore = require('../../memory/vectorStore');
const { LearnedRule } = require('../../db/models');
const { getClusters } = require('../../config/clusterConfig');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');

const router = express.Router();

// ── Agent Management (admin only) ──────────────────────────────────────────
router.get('/api/agents', requireAuth, requireAdmin, asyncHandler(async (_req, res) => {
  const clusters = getClusters();
  const agents = [
    { id: 'planner',       name: 'Planner Agent',              description: 'Analyzes pod issues and plans remediation actions', model: process.env.OPENAI_MODEL || 'default', enabled: true, type: 'core' },
    { id: 'guardian',      name: 'Guardian Agent',             description: 'Validates action safety before execution (risk, policy, tier)', model: process.env.GUARDIAN_MODEL || process.env.OPENAI_MODEL || 'default', enabled: true, type: 'core' },
    { id: 'reflection',    name: 'Reflection Agent',           description: 'Learns from outcomes and generates rules for future cycles', model: process.env.GUARDIAN_MODEL || process.env.OPENAI_MODEL || 'default', enabled: true, type: 'core' },
    { id: 'investigator',  name: 'Investigator Agent',         description: 'Deep-dives into escalated issues with logs and metrics', model: process.env.OPENAI_MODEL || 'default', enabled: true, type: 'core' },
    { id: 'pod-analyzer',  name: 'Pod Analyzer',               description: 'Detects unhealthy pods and classifies failure reasons', model: null, enabled: true, type: 'analyzer' },
    { id: 'node-analyzer', name: 'Node Analyzer',              description: 'Monitors node conditions, pressure, and flapping', model: null, enabled: true, type: 'analyzer' },
    { id: 'event-analyzer',name: 'Event Analyzer',             description: 'Parses Kubernetes warning events for anomalies', model: null, enabled: true, type: 'analyzer' },
    { id: 'correlation',   name: 'Change Correlation Engine',  description: 'Correlates recent deployments with failures', model: process.env.OPENAI_MODEL || 'default', enabled: true, type: 'engine' },
    { id: 'capacity',      name: 'Capacity Forecast Engine',   description: 'Predicts resource exhaustion via regression', model: null, enabled: process.env.CAPACITY_FORECAST_ENABLED === 'true', type: 'engine' },
  ];
  const config = {
    cycleIntervalMs:  parseInt(process.env.CYCLE_INTERVAL_MS || '30000', 10),
    llmModel:         process.env.OPENAI_MODEL || '',
    guardianModel:    process.env.GUARDIAN_MODEL || '',
    prometheusUrl:    process.env.PROMETHEUS_URL || 'http://localhost:9090',
    prometheusAvailable: metricsCollector.isAvailable(),
    vectorStoreReady:    vectorStore.ready,
  };
  res.json({ agents, clusters, config });
}));

router.put('/api/agents/config', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { key, value } = req.body;
  const ALLOWED = ['CYCLE_INTERVAL_MS', 'CAPACITY_FORECAST_ENABLED', 'OPENAI_MODEL', 'GUARDIAN_MODEL'];
  if (!ALLOWED.includes(key)) return res.status(400).json({ error: `Cannot update ${key}` });
  process.env[key] = String(value);
  res.json({ ok: true, key, value: String(value) });
}));

// ── Learned Rules (admin only) ────────────────────────────────────────────────
router.get('/api/agents/rules', requireAuth, requireAdmin, asyncHandler(async (_req, res) => {
  const rules = await LearnedRule.find().sort({ updatedAt: -1 }).lean();
  res.json(rules);
}));

router.put('/api/agents/rules/:id', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { active } = req.body;
  const rule = await LearnedRule.findByIdAndUpdate(req.params.id, { active }, { new: true });
  if (!rule) return res.status(404).json({ error: 'Rule not found' });
  res.json(rule);
}));

router.delete('/api/agents/rules/:id', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const rule = await LearnedRule.findByIdAndDelete(req.params.id);
  if (!rule) return res.status(404).json({ error: 'Rule not found' });
  res.json({ ok: true });
}));

module.exports = router;
