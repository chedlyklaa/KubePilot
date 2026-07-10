'use strict';
const mongoose = require('mongoose');
const bcrypt   = require('bcrypt');
const { User, ApprovalHistory, EscalationHistory, ChatHistory, CommandHistory } = require('../db/models');
const authService = require('../api/authService');
const mailer      = require('./mailer');

const SALT_ROUNDS = 10;

// OTP store: userId → { otp, expiresAt, issuedAt }
// Centralised here instead of inlined in server.js
const otpStore = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of otpStore) {
    if (now > entry.expiresAt) otpStore.delete(id);
  }
}, 15 * 60 * 1000).unref();

class ProfileService {
  async isEmailConfigured() {
    return mailer.isConfigured();
  }

  async requestOtp(user) {
    if (!(await mailer.isConfigured()))
      throw Object.assign(new Error('Email service is not configured on this server'), { status: 503 });

    const existing = otpStore.get(user.id);
    if (existing && Date.now() - existing.issuedAt < 2 * 60 * 1000)
      throw Object.assign(new Error('Please wait before requesting another code'), { status: 429 });

    const otp = String(Math.floor(100000 + Math.random() * 900000));
    await mailer.sendOtp(user.email, user.name, otp);
    otpStore.set(user.id, { otp, expiresAt: Date.now() + 10 * 60 * 1000, issuedAt: Date.now() });
    return { sent: true };
  }

  async getStats(userId, userEmail) {
    const since = new Date();
    since.setDate(since.getDate() - 30);

    const [
      escalationsHandled, escalationsFixed, approvalsDecided,
      [chatRes], [cmdRes], escsByDay, approvalsByDay,
    ] = await Promise.all([
      EscalationHistory.countDocuments({ 'acknowledgedBy.userId': userId }),
      EscalationHistory.countDocuments({ 'stateUpdatedBy.email': userEmail, status: 'fixed' }),
      ApprovalHistory.countDocuments({ 'decidedBy.email': userEmail }),
      ChatHistory.aggregate([
        { $match: { userId } },
        { $project: { count: { $size: { $filter: { input: { $ifNull: ['$messages', []] }, cond: { $eq: ['$$this.role', 'user'] } } } } } },
      ]),
      CommandHistory.aggregate([
        { $match: { userId } },
        { $project: { count: { $size: { $ifNull: ['$turns', []] } } } },
      ]),
      EscalationHistory.aggregate([
        { $match: { 'acknowledgedBy.userId': userId, acknowledgedAt: { $gte: since } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$acknowledgedAt' } }, count: { $sum: 1 } } },
      ]),
      ApprovalHistory.aggregate([
        { $match: { 'decidedBy.email': userEmail, createdAt: { $gte: since } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
      ]),
    ]);

    const daily = {};
    for (const d of escsByDay)      daily[d._id] = (daily[d._id] ?? 0) + d.count;
    for (const d of approvalsByDay) daily[d._id] = (daily[d._id] ?? 0) + d.count;

    return {
      escalationsHandled,
      escalationsFixed,
      approvalsDecided,
      chatMessages: chatRes?.count ?? 0,
      commandsRun:  cmdRes?.count  ?? 0,
      daily,
    };
  }

  async updateProfile(userId, { name, password, currentPassword, otp }) {
    const upd = {};
    if (name?.trim()) upd.name = name.trim();

    if (password?.trim()) {
      if (!currentPassword && !otp)
        throw Object.assign(
          new Error('Provide your current password or an email verification code to change your password'),
          { status: 400 }
        );

      if (currentPassword) {
        const dbUser = await User.findById(userId);
        if (!dbUser || !(await bcrypt.compare(currentPassword, dbUser.password)))
          throw Object.assign(new Error('Current password is incorrect'), { status: 400 });
      } else {
        const stored = otpStore.get(userId);
        if (!stored || Date.now() > stored.expiresAt || stored.otp !== String(otp))
          throw Object.assign(new Error('Invalid or expired verification code'), { status: 400 });
        otpStore.delete(userId);
      }
      upd.password = await bcrypt.hash(password, SALT_ROUNDS);
    }

    if (!Object.keys(upd).length)
      throw Object.assign(new Error('Nothing to update'), { status: 400 });

    const u = await User.findByIdAndUpdate(userId, upd, { new: true, runValidators: true }).select('-password');
    if (!u) throw Object.assign(new Error('User not found'), { status: 404 });
    if (upd.name) authService.updateUserPayload(userId, { name: u.name });
    return { id: u._id, email: u.email, name: u.name, role: u.role };
  }

  async getActivity(userId, userEmail) {
    const [escalations, approvals] = await Promise.all([
      EscalationHistory.find({
        $or: [{ 'acknowledgedBy.userId': userId }, { 'assignedTo.userId': userId }],
      }).sort({ escalatedAt: -1 }).limit(50).lean(),
      ApprovalHistory.find({ 'decidedBy.email': userEmail })
        .sort({ createdAt: -1 }).limit(50).lean(),
    ]);
    return { escalations, approvals };
  }

  async getAdminView(id) {
    if (!mongoose.Types.ObjectId.isValid(id))
      throw Object.assign(new Error('Invalid user id'), { status: 400 });

    const targetUser = await User.findById(id).select('-password').lean();
    if (!targetUser) throw Object.assign(new Error('User not found'), { status: 404 });

    const userId    = targetUser._id.toString();
    const userEmail = targetUser.email;
    const [stats, activity] = await Promise.all([
      this.getStats(userId, userEmail),
      this.getActivity(userId, userEmail),
    ]);

    return { user: targetUser, stats, activity };
  }
}

module.exports = new ProfileService();
