'use strict';
const express = require('express');
const authService = require('../authService');
const sseTicketStore = require('../sseTicketStore');
const { requireAuth, requireAdmin, loadPerms, getToken } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { authLimiter } = require('../middleware/rateLimit');

const router = express.Router();

router.post('/api/auth/sse-ticket', requireAuth, (req, res) => {
  res.json({ ticket: sseTicketStore.issue(getToken(req)) });
});

router.post('/api/auth/login', authLimiter, asyncHandler(async (req, res) => {
  const result = await authService.login(req.body.email, req.body.password);
  if (!result) return res.status(401).json({ error: 'Invalid email or password' });
  res.json(result);
}));
router.post('/api/auth/logout', requireAuth, (req, res) => {
  authService.logout(getToken(req)); res.json({ success: true });
});
router.get('/api/auth/me', requireAuth, (req, res) => res.json(req.user));

router.post('/api/auth/forgot-password', authLimiter, asyncHandler(async (req, res) => {
  await authService.forgotPassword(req.body.email || '');
  res.json({ success: true });
}));

router.post('/api/auth/reset-password', authLimiter, asyncHandler(async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password) return res.status(400).json({ error: 'token and password required' });
  await authService.resetPassword(token, password);
  res.json({ success: true });
}));

router.get('/api/auth/permissions', requireAuth, loadPerms, (req, res) => {
  res.json({ permissions: req.permissions });
});

module.exports = router;
