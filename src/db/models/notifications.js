const mongoose = require('mongoose');
const { Schema } = mongoose;

const NotificationSchema = new Schema({
  targetUserIds: [String],
  type:    { type: String, enum: ['info', 'warn', 'error', 'success'], default: 'info' },
  message: { type: String, required: true },
  data:    Schema.Types.Mixed,
  readBy:  [String],
}, { timestamps: true });

const NotificationChannelConfigSchema = new Schema({
  type:      { type: String, required: true, unique: true, index: true,
               enum: ['teams', 'email', 'slack', 'telegram', 'discord', 'webhook', 'inApp'] },
  enabled:   { type: Boolean, default: false },
  config:    { type: String, default: '' },
  updatedBy: String,
}, { timestamps: true });

const NotificationRoutingConfigSchema = new Schema({
  routing: {
    INFO:     { type: [String], default: ['inApp'] },
    WARNING:  { type: [String], default: ['inApp', 'teams'] },
    ERROR:    { type: [String], default: ['inApp', 'teams', 'email'] },
    CRITICAL: { type: [String], default: ['inApp', 'teams', 'email', 'slack'] },
  },
  subscriptions: { type: Schema.Types.Mixed, default: {} },
}, { timestamps: true });

const UserNotificationPreferencesSchema = new Schema({
  userId:        { type: String, required: true, unique: true, index: true },
  channels:      { type: [String], default: ['inApp'] },
  categories:    { type: [String], default: [] },
  notifyEmail:   { type: String, default: '' },
}, { timestamps: true });

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
