const mongoose = require('mongoose');
const { Schema } = mongoose;

// ── Notification ──────────────────────────────────────────────────────────────
const NotificationSchema = new Schema({
  targetUserIds: [String],   // user _id strings
  type:    { type: String, enum: ['info', 'warn', 'error', 'success'], default: 'info' },
  message: { type: String, required: true },
  data:    Schema.Types.Mixed,
  readBy:  [String],          // user _id strings who read it
}, { timestamps: true });

// ── Notification Channel Config ───────────────────────────────────────────────
// One document per channel type. `config` stores AES-GCM encrypted JSON secrets.
const NotificationChannelConfigSchema = new Schema({
  type:      { type: String, required: true, unique: true, index: true,
               enum: ['teams', 'email', 'slack', 'telegram', 'discord', 'webhook', 'inApp'] },
  enabled:   { type: Boolean, default: false },
  config:    { type: String, default: '' }, // encrypted
  updatedBy: String,
}, { timestamps: true });

// ── Notification Routing Config ───────────────────────────────────────────────
// Singleton (one document). Maps severity → [channel types] and channel → [categories].
const NotificationRoutingConfigSchema = new Schema({
  routing: {
    INFO:     { type: [String], default: ['inApp'] },
    WARNING:  { type: [String], default: ['inApp', 'teams'] },
    ERROR:    { type: [String], default: ['inApp', 'teams', 'email'] },
    CRITICAL: { type: [String], default: ['inApp', 'teams', 'email', 'slack'] },
  },
  subscriptions: { type: Schema.Types.Mixed, default: {} },
}, { timestamps: true });

// ── User Notification Preferences ────────────────────────────────────────────
// Per-user settings: which channels they want, which categories, personal contact.
const UserNotificationPreferencesSchema = new Schema({
  userId:        { type: String, required: true, unique: true, index: true },
  channels:      { type: [String], default: ['inApp'] }, // channel types enabled for this user
  categories:    { type: [String], default: [] },        // empty = all categories
  notifyEmail:   { type: String, default: '' },          // personal notification email (may differ from account)
}, { timestamps: true });

// ── Notification Delivery Log ─────────────────────────────────────────────────
const NotificationDeliveryLogSchema = new Schema({
  notificationId: { type: String, required: true, index: true },
  channel:   { type: String, required: true },
  status:    { type: String, enum: ['PENDING', 'SENT', 'FAILED', 'RETRYING'], default: 'PENDING', index: true },
  recipient: String,
  retries:   { type: Number, default: 0 },
  error:     String,
  sentAt:    Date,
  severity:  String,
  category:  String,
  title:     String,
  message:   String,
}, { timestamps: true });

module.exports = {
  Notification:                mongoose.model('Notification',                NotificationSchema),
  NotificationChannelConfig:   mongoose.model('NotificationChannelConfig',   NotificationChannelConfigSchema),
  NotificationRoutingConfig:   mongoose.model('NotificationRoutingConfig',   NotificationRoutingConfigSchema),
  UserNotificationPreferences: mongoose.model('UserNotificationPreferences', UserNotificationPreferencesSchema),
  NotificationDeliveryLog:     mongoose.model('NotificationDeliveryLog',     NotificationDeliveryLogSchema),
};
