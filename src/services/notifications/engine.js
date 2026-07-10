'use strict';

const { randomUUID } = require('crypto');
const { decrypt }    = require('./crypto');

// ── Provider registry ─────────────────────────────────────────────────────────
const PROVIDERS = {
  teams:   require('./providers/teams'),
  email:   require('./providers/email'),
  slack:   require('./providers/slack'),
  inApp:   require('./providers/inApp'),
};

// Stub for Phase 2 channels — config accepted but send is a no-op until implemented
const STUB = {
  send:           async () => { throw new Error('Provider not yet implemented'); },
  testConnection: async () => { throw new Error('Provider not yet implemented'); },
};

PROVIDERS.telegram = STUB;
PROVIDERS.discord  = STUB;
PROVIDERS.webhook  = STUB;

// ── Default routing (used when DB has no config yet) ─────────────────────────
const DEFAULT_ROUTING = {
  INFO:     ['inApp'],
  WARNING:  ['inApp', 'teams'],
  ERROR:    ['inApp', 'teams', 'email'],
  CRITICAL: ['inApp', 'teams', 'email', 'slack'],
};

// ── Routing cache (60 s TTL — avoids DB hit on every notification) ────────────
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

// ── Collect personal email recipients from user preferences ──────────────────
// Returns array of email addresses for users who have email enabled.
// Pass targetRole to restrict delivery to a specific role (e.g. 'admin').
// Pass targetUserIds to restrict delivery to a specific, already-resource-scoped set of
// users (e.g. escalationStore only resolves recipients who actually have access to the
// affected cluster/namespace) — channel/category preferences still apply on top of it.
async function _getPersonalEmailRecipients(category, targetRole = null, targetUserIds = null) {
  try {
    const { UserNotificationPreferences, User } = require('../../db/models');
    let prefs = await UserNotificationPreferences.find({ channels: 'email' }).lean();

    if (Array.isArray(targetUserIds)) {
      const allowed = new Set(targetUserIds.map(String));
      prefs = prefs.filter(p => allowed.has(p.userId?.toString()));
    }

    // Batch-fetch all users in one query to avoid N+1 DB round-trips
    const userIds  = prefs.map(p => p.userId);
    const users    = await User.find({ _id: { $in: userIds } }).select('email active role').lean();
    const userMap  = new Map(users.map(u => [u._id.toString(), u]));

    const emails = [];
    for (const pref of prefs) {
      // Skip if user has category filtering and this category is not in their list
      if (pref.categories?.length > 0 && category && !pref.categories.includes(category)) continue;

      const user = userMap.get(pref.userId?.toString());
      if (!user?.active) continue;
      if (targetRole && user.role !== targetRole) continue;

      emails.push(pref.notifyEmail?.trim() || user.email);
    }
    return [...new Set(emails.filter(Boolean))]; // deduplicate and drop empty
  } catch {
    return [];
  }
}

// ── Load enabled channels with decrypted config ───────────────────────────────
async function _getEnabledChannels() {
  try {
    const { NotificationChannelConfig } = require('../../db/models');
    const docs = await NotificationChannelConfig.find({ enabled: true }).lean();
    return docs.map(d => ({ type: d.type, config: decrypt(d.config) }));
  } catch {
    // Fall back to env-based Teams config so existing deployments keep working
    const fallback = [];
    if (process.env.TEAMS_WEBHOOK_URL) {
      fallback.push({ type: 'teams', config: { webhookUrl: process.env.TEAMS_WEBHOOK_URL } });
    }
    fallback.push({ type: 'inApp', config: {} });
    return fallback;
  }
}

// ── Retry schedule (delays in ms) ────────────────────────────────────────────
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

// ── Core dispatch ─────────────────────────────────────────────────────────────
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

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Emit a notification event. Agents and stores call this instead of sending
 * directly to any channel.
 *
 * @param {object} event
 * @param {string} event.severity   INFO | WARNING | ERROR | CRITICAL
 * @param {string} event.category   e.g. 'Incidents', 'Cluster Health'
 * @param {string} event.title
 * @param {string} event.message
 * @param {string} [event.namespace]
 * @param {string} [event.source]
 * @param {object} [event.metadata]
 * @param {string[]} [event.targetUserIds]  override for inApp delivery
 */
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

  // inApp is always dispatched regardless of routing rules (it's the fallback channel)
  const channelsToUse = new Set(targets);
  channelsToUse.add('inApp');

  // Pre-fetch personal email recipients once (only if email channel is active).
  // targetRole restricts delivery to a specific role (e.g. 'admin' for approvals);
  // targetUserIds restricts it to an already resource-scoped set of users (e.g.
  // escalations only resolving to admins + developers with access to that cluster).
  const personalEmails = channelsToUse.has('email') && enabledByType['email']
    ? await _getPersonalEmailRecipients(
        notification.category,
        notification.targetRole,
        notification.targetUserIds?.length ? notification.targetUserIds : null
      )
    : [];

  await Promise.all([...channelsToUse].map(async type => {
    const config = enabledByType[type];
    // Skip external channels that are not enabled (inApp skips config check)
    if (type !== 'inApp' && !config) return;

    // For email: merge system Default Recipients with personal preference addresses
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
