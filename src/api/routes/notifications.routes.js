'use strict';
const express = require('express');
const notificationStore = require('../notificationStore');
const {
  User, NotificationChannelConfig, NotificationRoutingConfig,
  NotificationDeliveryLog, UserNotificationPreferences,
} = require('../../db/models');
const notifCrypto   = require('../../services/notifications/crypto');
const notifEngine   = require('../../services/notifications/engine');
const emailProvider = require('../../services/notifications/providers/email');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { sseHeaders } = require('../middleware/sse');
const { asyncHandler } = require('../middleware/asyncHandler');

const router = express.Router();

// ── Live notifications (all authenticated users) ───────────────────────────
router.get('/api/notifications', requireAuth, async (req, res) => {
  res.json(await notificationStore.getForUser(req.user.id));
});
router.get('/api/notifications/stream', requireAuth, (req, res) => {
  sseHeaders(res);
  const unsub = notificationStore.register(req.user.id, res);
  req.on('close', unsub);
});
router.put('/api/notifications/:id/read', requireAuth, async (req, res) => {
  await notificationStore.markRead(req.user.id, req.params.id);
  res.json({ success: true });
});
router.put('/api/notifications/read-all', requireAuth, async (req, res) => {
  await notificationStore.markAllRead(req.user.id);
  res.json({ success: true });
});

// ── Per-user preferences (all authenticated users) ─────────────────────────
router.get('/api/notifications/preferences', requireAuth, asyncHandler(async (req, res) => {
  const doc = await UserNotificationPreferences.findOne({ userId: req.user.id }).lean();
  res.json(doc ?? { userId: req.user.id, channels: ['inApp'], categories: [], notifyEmail: req.user.email ?? '' });
}));

router.put('/api/notifications/preferences', requireAuth, asyncHandler(async (req, res) => {
  const { channels, categories, notifyEmail } = req.body;
  await UserNotificationPreferences.findOneAndUpdate(
    { userId: req.user.id },
    { channels: channels ?? ['inApp'], categories: categories ?? [], notifyEmail: notifyEmail ?? '' },
    { upsert: true }
  );
  res.json({ ok: true });
}));

// POST /api/notifications/preferences/test-email — send a test email to own notification email
router.post('/api/notifications/preferences/test-email', requireAuth, async (req, res) => {
  try {
    // Resolve destination: saved notifyEmail → account email → error
    const pref    = await UserNotificationPreferences.findOne({ userId: req.user.id }).lean();
    const toEmail = pref?.notifyEmail || req.user.email;
    if (!toEmail) return res.json({ ok: false, message: 'No email address configured' });

    // Load SMTP config from system channel settings
    const channelDoc = await NotificationChannelConfig.findOne({ type: 'email' }).lean();
    if (!channelDoc?.enabled) return res.json({ ok: false, message: 'Email channel is not enabled. Ask your admin to configure it first.' });

    const cfg = notifCrypto.decrypt(channelDoc.config ?? '');

    await emailProvider.send({
      severity: 'INFO',
      category: 'Recommendations',
      title:    'KubePilot — Test Notification',
      message:  `This is a test notification sent to ${toEmail}. Your email notifications are working correctly.`,
      source:   'KubePilot Notification Center',
    }, { ...cfg, recipients: toEmail });

    res.json({ ok: true, message: `Test email sent to ${toEmail}` });
  } catch (err) {
    res.json({ ok: false, message: err.message });
  }
});

// GET /api/notifications/admin/users-preferences — admin: all users + their prefs
router.get('/api/notifications/admin/users-preferences', requireAuth, requireAdmin, asyncHandler(async (_req, res) => {
  const [users, prefs] = await Promise.all([
    User.find({ active: true }).select('_id name email role').lean(),
    UserNotificationPreferences.find().lean(),
  ]);
  const prefsById = Object.fromEntries(prefs.map(p => [p.userId, p]));
  res.json(users.map(u => ({
    userId:      u._id.toString(),
    name:        u.name,
    email:       u.email,
    role:        u.role,
    prefs:       prefsById[u._id.toString()] ?? { channels: ['inApp'], categories: [], notifyEmail: u.email },
  })));
}));

const CHANNEL_TYPES = ['teams', 'email', 'slack', 'inApp', 'telegram', 'discord', 'webhook'];

// GET /api/notifications/channels — list all channels with masked config
router.get('/api/notifications/channels', requireAuth, requireAdmin, asyncHandler(async (_req, res) => {
  const docs = await NotificationChannelConfig.find().lean();
  const byType = Object.fromEntries(docs.map(d => [d.type, d]));
  const result = CHANNEL_TYPES.map(type => {
    const doc = byType[type];
    const cfg = doc ? notifCrypto.decrypt(doc.config ?? '') : {};
    return { type, enabled: doc?.enabled ?? false, config: notifCrypto.mask(cfg), updatedAt: doc?.updatedAt };
  });
  res.json(result);
}));

// PUT /api/notifications/channels/:type — save channel config
router.put('/api/notifications/channels/:type', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { type } = req.params;
  if (!CHANNEL_TYPES.includes(type)) return res.status(400).json({ error: 'Unknown channel type' });
  const { enabled, config } = req.body;
  const existing = await NotificationChannelConfig.findOne({ type }).lean();
  // Merge: keep stored secrets for masked ('••••••••') fields sent back from frontend
  const stored  = existing ? notifCrypto.decrypt(existing.config ?? '') : {};
  const merged  = { ...stored };
  for (const [k, v] of Object.entries(config ?? {})) {
    if (v !== '••••••••') merged[k] = v;
  }
  await NotificationChannelConfig.findOneAndUpdate(
    { type },
    { type, enabled: enabled ?? false, config: notifCrypto.encrypt(merged), updatedBy: req.user.name },
    { upsert: true }
  );
  notifEngine.invalidateRoutingCache();
  res.json({ ok: true });
}));

// POST /api/notifications/channels/:type/test — test channel connectivity
router.post('/api/notifications/channels/:type/test', requireAuth, requireAdmin, async (req, res) => {
  const { type } = req.params;
  if (!CHANNEL_TYPES.includes(type)) return res.status(400).json({ error: 'Unknown channel type' });
  try {
    const provider = notifEngine.PROVIDERS[type];
    if (!provider) return res.status(400).json({ error: 'Provider not available' });

    // Resolve config: merge stored + any overrides sent in body (unmasked)
    const existing = await NotificationChannelConfig.findOne({ type }).lean();
    const stored   = existing ? notifCrypto.decrypt(existing.config ?? '') : {};
    const override = req.body.config ?? {};
    const merged   = { ...stored };
    for (const [k, v] of Object.entries(override)) {
      if (v !== '••••••••') merged[k] = v;
    }

    await provider.testConnection(merged);
    res.json({ ok: true, message: 'Connection successful' });
  } catch (err) { res.status(200).json({ ok: false, message: err.message }); }
});

// GET /api/notifications/routing — get routing rules
router.get('/api/notifications/routing', requireAuth, requireAdmin, asyncHandler(async (_req, res) => {
  const doc = await NotificationRoutingConfig.findOne().lean();
  res.json(doc?.routing ?? { INFO: ['inApp'], WARNING: ['inApp','teams'], ERROR: ['inApp','teams','email'], CRITICAL: ['inApp','teams','email','slack'] });
}));

// PUT /api/notifications/routing — save routing rules
router.put('/api/notifications/routing', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  await NotificationRoutingConfig.findOneAndUpdate({}, { routing: req.body }, { upsert: true });
  notifEngine.invalidateRoutingCache();
  res.json({ ok: true });
}));

// GET /api/notifications/subscriptions — event category subscriptions per channel
router.get('/api/notifications/subscriptions', requireAuth, requireAdmin, asyncHandler(async (_req, res) => {
  const doc = await NotificationRoutingConfig.findOne().lean();
  res.json(doc?.subscriptions ?? {});
}));

// PUT /api/notifications/subscriptions
router.put('/api/notifications/subscriptions', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  await NotificationRoutingConfig.findOneAndUpdate({}, { subscriptions: req.body }, { upsert: true });
  res.json({ ok: true });
}));

// GET /api/notifications/delivery-log?page=1&limit=50&channel=&status=
router.get('/api/notifications/delivery-log', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const page    = Math.max(1, parseInt(req.query.page  ?? '1',  10));
  const limit   = Math.min(100, parseInt(req.query.limit ?? '50', 10));
  const filter  = {};
  if (req.query.channel) filter.channel = req.query.channel;
  if (req.query.status)  filter.status  = req.query.status;
  const [docs, total] = await Promise.all([
    NotificationDeliveryLog.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    NotificationDeliveryLog.countDocuments(filter),
  ]);
  res.json({ docs, total, page, pages: Math.ceil(total / limit) });
}));

module.exports = router;
