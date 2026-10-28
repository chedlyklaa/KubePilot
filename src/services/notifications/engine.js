'use strict';

const { randomUUID } = require('crypto');
const { decrypt }    = require('./crypto');

const PROVIDERS = {
  teams:   require('./providers/teams'),
  email:   require('./providers/email'),
  slack:   require('./providers/slack'),
  inApp:   require('./providers/inApp'),
};

const STUB = {
  send:           async () => { throw new Error('Provider not yet implemented'); },
  testConnection: async () => { throw new Error('Provider not yet implemented'); },
};

PROVIDERS.telegram = STUB;
PROVIDERS.discord  = STUB;
PROVIDERS.webhook  = STUB;

const DEFAULT_ROUTING = {
  INFO:     ['inApp'],
  WARNING:  ['inApp', 'teams'],
  ERROR:    ['inApp', 'teams', 'email'],
  CRITICAL: ['inApp', 'teams', 'email', 'slack'],
};

let _routingCache    = null;
let _routingCacheAt  = 0;
const CACHE_TTL_MS   = 60_000;

async function _getRouting() {
  if (_routingCache && Date.now() - _routingCacheAt < CACHE_TTL_MS) return _routingCache;
  try {
    const { NotificationRoutingConfig } = require('../../db/models');
    const doc = await NotificationRoutingConfig.findOne().lean();
    _routingCache   = doc?.routing ?? DEFAULT_ROUTING;
    _routingCacheAt = Date.now();
    return _routingCache;
  } catch {
    return DEFAULT_ROUTING;
  }
}

function invalidateRoutingCache() {
  _routingCache   = null;
  _routingCacheAt = 0;
}

// Get users who want email notifications
async function _getPersonalEmailRecipients(category, targetRole = null, targetUserIds = null) {
  try {
    const { UserNotificationPreferences, User } = require('../../db/models');
    let prefs = await UserNotificationPreferences.find({ channels: 'email' }).lean();

    if (Array.isArray(targetUserIds)) {
      const allowed = new Set(targetUserIds.map(String));
      prefs = prefs.filter(p => allowed.has(p.userId?.toString()));
    }

    const userIds  = prefs.map(p => p.userId);
    const users    = await User.find({ _id: { $in: userIds } }).select('email active role').lean();
    const userMap  = new Map(users.map(u => [u._id.toString(), u]));

    const emails = [];
    for (const pref of prefs) {
      if (pref.categories?.length > 0 && category && !pref.categories.includes(category)) continue;

      const user = userMap.get(pref.userId?.toString());
      if (!user?.active) continue;
      if (targetRole && user.role !== targetRole) continue;

      emails.push(pref.notifyEmail?.trim() || user.email);
    }
    return [...new Set(emails.filter(Boolean))];
  } catch {
    return [];
  }
}

// Load the enabled channels
async function _getEnabledChannels() {
  try {
    const { NotificationChannelConfig } = require('../../db/models');
    const docs = await NotificationChannelConfig.find({ enabled: true }).lean();
    return docs.map(d => ({ type: d.type, config: decrypt(d.config) }));
  } catch {
    const fallback = [];
    if (process.env.TEAMS_WEBHOOK_URL) {
      fallback.push({ type: 'teams', config: { webhookUrl: process.env.TEAMS_WEBHOOK_URL } });
    }
    fallback.push({ type: 'inApp', config: {} });
    return fallback;
  }
}

const RETRY_DELAYS = [30_000, 120_000, 300_000];

async function _logDelivery(fields) {
  try {
    const { NotificationDeliveryLog } = require('../../db/models');
    return await NotificationDeliveryLog.create(fields);
  } catch { return null; }
}

async function _updateLog(id, fields) {
  if (!id) return;
  try {
    const { NotificationDeliveryLog } = require('../../db/models');
    await NotificationDeliveryLog.findByIdAndUpdate(id, fields);
  } catch {}
}

// Send a notification to the channels
async function _dispatch(notification, channelType, config, logId, attempt = 0) {
  const provider = PROVIDERS[channelType];
  if (!provider) return;

  try {
    await provider.send(notification, config);
    await _updateLog(logId, { status: 'SENT', sentAt: new Date(), retries: attempt });
    console.log(`[NotifEngine] ✓ ${channelType} → ${notification.title}`);
  } catch (err) {
    console.warn(`[NotifEngine] ✗ ${channelType} attempt ${attempt + 1}: ${err.message}`);

    if (attempt < RETRY_DELAYS.length) {
      await _updateLog(logId, { status: 'RETRYING', retries: attempt + 1, error: err.message });
      setTimeout(
        () => _dispatch(notification, channelType, config, logId, attempt + 1),
        RETRY_DELAYS[attempt]
      );
    } else {
      await _updateLog(logId, { status: 'FAILED', retries: attempt, error: err.message });
      console.error(`[NotifEngine] FAILED ${channelType} after ${attempt + 1} attempts: ${err.message}`);
    }
  }
}

// Emit a notification event
async function emit(event) {
  const notification = {
    id:        randomUUID(),
    timestamp: new Date().toISOString(),
    severity:  (event.severity ?? 'INFO').toUpperCase(),
    category:  event.category  ?? 'General',
    title:     event.title     ?? '',
    message:   event.message   ?? '',
    namespace: event.namespace ?? null,
    source:    event.source    ?? null,
    metadata:  event.metadata  ?? {},
    targetUserIds: event.targetUserIds ?? [],
    targetRole:    event.targetRole    ?? null,
  };

  const [routing, channels] = await Promise.all([_getRouting(), _getEnabledChannels()]);
  const targets = routing[notification.severity] ?? routing.INFO ?? ['inApp'];

  const enabledByType = Object.fromEntries(channels.map(c => [c.type, c.config]));

  const channelsToUse = new Set(targets);
  channelsToUse.add('inApp');

  const personalEmails = channelsToUse.has('email') && enabledByType['email']
    ? await _getPersonalEmailRecipients(
        notification.category,
        notification.targetRole,
        notification.targetUserIds?.length ? notification.targetUserIds : null
      )
    : [];

  await Promise.all([...channelsToUse].map(async type => {
    const config = enabledByType[type];
    if (type !== 'inApp' && !config) return;

    let effectiveConfig = config ?? {};
    if (type === 'email' && personalEmails.length > 0) {
      const systemRecipients = config.recipients
        ? (Array.isArray(config.recipients) ? config.recipients : config.recipients.split(',').map(s => s.trim()))
        : [];
      const merged = [...new Set([...systemRecipients, ...personalEmails])];
      effectiveConfig = { ...config, recipients: merged };
    }

    const logDoc = await _logDelivery({
      notificationId: notification.id,
      channel:  type,
      status:   'PENDING',
      severity: notification.severity,
      category: notification.category,
      title:    notification.title,
      message:  notification.message,
    });

    _dispatch(notification, type, effectiveConfig, logDoc?._id ?? null, 0);
  }));
}

module.exports = { emit, invalidateRoutingCache, PROVIDERS };
