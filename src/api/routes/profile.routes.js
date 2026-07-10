'use strict';
const express = require('express');
const profileService = require('../../services/profileService');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');

const router = express.Router();

// Request OTP for password change via email
router.post('/api/profile/request-otp', requireAuth, asyncHandler(async (req, res) => {
  res.json(await profileService.requestOtp(req.user));
}));

router.get('/api/profile/email-available', requireAuth, async (_req, res) => {
  res.json({ available: await profileService.isEmailConfigured() });
});

router.get('/api/profile/stats', requireAuth, asyncHandler(async (req, res) => {
  res.json(await profileService.getStats(req.user.id, req.user.email));
}));

router.put('/api/profile', requireAuth, asyncHandler(async (req, res) => {
  res.json(await profileService.updateProfile(req.user.id, req.body));
}));

router.get('/api/profile/activity', requireAuth, asyncHandler(async (req, res) => {
  res.json(await profileService.getActivity(req.user.id, req.user.email));
}));

router.get('/api/users/:id/profile', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  res.json(await profileService.getAdminView(req.params.id));
}));

module.exports = router;
