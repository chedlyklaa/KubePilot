'use strict';
const express = require('express');
const llm = require('../llmClient');
const chatService = require('../../services/chatService');
const chatTools = require('../../services/chatTools');
const permissionService = require('../../services/permissionService');
const { ChatHistory } = require('../../db/models');
const { getClusters } = require('../../config/clusterConfig');
const { requireAuth, loadPerms } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');

const router = express.Router();
const { buildClusterContext } = chatService;

// ── Chat config (returns LLM model info — API key stays server-side) ──────
router.get('/api/chat/config', requireAuth, (_req, res) => {
  res.json({
    model:   process.env.OPENAI_MODEL   || '',
    baseURL: process.env.OPENAI_BASE_URL || '',
  });
});

// ── Chat endpoints (delegated to chatService) ──────────────────────────────
router.post('/api/chat', requireAuth, (req, res) => chatService.chatNonStreaming(req, res, llm));

router.get('/api/chat/cluster-context', requireAuth, loadPerms, asyncHandler(async (req, res) => {
  const scoped = permissionService.filterClusters(req.permissions, getClusters());
  const text = await buildClusterContext(scoped);
  res.json({ text, timestamp: new Date().toISOString() });
}));

router.post('/api/chat/stream', requireAuth, (req, res) => chatService.streamChat(req, res, { llm, chatTools }));
router.post('/api/chat/pdf-report', requireAuth, (req, res) => chatService.generatePdfReport(req, res, llm));

// ── Chat history (per-user, persisted in MongoDB) ────────────────────────────
router.get('/api/chat/history', requireAuth, asyncHandler(async (req, res) => {
  const doc = await ChatHistory.findOne({ userId: req.user.id });
  const all = doc?.messages || [];
  const limit = parseInt(req.query.limit, 10);
  const before = parseInt(req.query.before, 10);
  if (limit > 0) {
    const end = before >= 0 ? before : all.length;
    const start = Math.max(0, end - limit);
    return res.json({ messages: all.slice(start, end), total: all.length, hasMore: start > 0 });
  }
  res.json({ messages: all, total: all.length, hasMore: false });
}));

router.patch('/api/chat/history', requireAuth, asyncHandler(async (req, res) => {
  const { messages } = req.body;
  if (!Array.isArray(messages)) return res.status(400).json({ error: 'messages array required' });
  const doc = await ChatHistory.findOneAndUpdate(
    { userId: req.user.id },
    { $push: { messages: { $each: messages } } },
    { upsert: true, new: true }
  );
  res.json({ ok: true, total: doc.messages.length });
}));

router.put('/api/chat/history', requireAuth, asyncHandler(async (req, res) => {
  const { messages } = req.body;
  if (!Array.isArray(messages)) return res.status(400).json({ error: 'messages array required' });
  await ChatHistory.findOneAndUpdate(
    { userId: req.user.id },
    { messages },
    { upsert: true }
  );
  res.json({ ok: true });
}));

router.delete('/api/chat/history', requireAuth, asyncHandler(async (req, res) => {
  await ChatHistory.findOneAndUpdate({ userId: req.user.id }, { messages: [] });
  res.json({ ok: true });
}));

module.exports = router;
