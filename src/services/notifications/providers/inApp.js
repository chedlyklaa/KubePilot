'use strict';

// Maps notification severity to the in-app notification type
const SEVERITY_TYPE = { CRITICAL: 'error', ERROR: 'error', WARNING: 'warn', INFO: 'info' };

async function _getAdminIds() {
  try {
    const { User } = require('../../../db/models');
    const admins = await User.find({ role: 'admin', active: true }).select('_id');
    return admins.map(a => a._id.toString());
  } catch { return []; }
}

async function send(notification, _config) {
  const notifStore = require('../../../api/notificationStore');
  const targets    = notification.targetUserIds?.length
    ? notification.targetUserIds
    : await _getAdminIds();

  if (!targets.length) return;

  await notifStore.send(targets, {
    type:    SEVERITY_TYPE[notification.severity] ?? 'info',
    message: notification.title
      ? `${notification.title}: ${notification.message}`
      : notification.message,
    data: {
      notificationId: notification.id,
      category:       notification.category,
      severity:       notification.severity,
      namespace:      notification.namespace,
      source:         notification.source,
      metadata:       notification.metadata,
    },
  });
}

async function testConnection(_config) {
  // In-app is always available — just verify the DB is reachable
  const { Notification } = require('../../../db/models');
  await Notification.findOne().select('_id').lean();
}

module.exports = { send, testConnection };
