const mongoose = require('mongoose');
const { Schema } = mongoose;

// ── User ──────────────────────────────────────────────────────────────────────
const UserSchema = new Schema({
  email:    { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true },
  name:     { type: String, required: true, trim: true },
  role:     { type: String, enum: ['admin', 'developer'], default: 'developer' },
  active:   { type: Boolean, default: true },
}, { timestamps: true });

// ── Approval history ──────────────────────────────────────────────────────────
const ApprovalHistorySchema = new Schema({
  issueKey:    { type: String, required: true },
  issue:       Schema.Types.Mixed,
  diagnosis:   Schema.Types.Mixed,
  decision:    { type: String, enum: ['approved', 'denied', 'timeout'], required: true },
  decidedBy:   { name: String, email: String, role: String },
  requestedAt: Date,
}, { timestamps: true });

// ── Escalation history ────────────────────────────────────────────────────────
// States: pending → acknowledged → in_progress → fixed | not_fixed | need_help
const EscalationHistorySchema = new Schema({
  issueKey:      { type: String, required: true },
  issue:         Schema.Types.Mixed,
  attempts:      Number,
  failedHistory: [Schema.Types.Mixed],
  escalatedAt:   { type: Date, default: Date.now },

  // Lifecycle
  status: {
    type: String,
    enum: ['pending', 'acknowledged', 'in_progress', 'fixed', 'not_fixed', 'need_help'],
    default: 'pending',
  },
  stateUpdatedAt:  Date,
  stateUpdatedBy:  { name: String, email: String, role: String },

  // Who acknowledged it
  acknowledgedBy:  { userId: String, name: String, email: String, role: String },
  acknowledgedAt:  Date,

  // Current assignee (may differ from acknowledger after reassignment)
  assignedTo:   { userId: String, name: String, email: String, role: String },
  assignedAt:   Date,
  assignedBy:   { name: String, email: String },

  // Reassignment request from developer
  reassignRequested:   { type: Boolean, default: false },
  reassignRequestedAt: Date,
  reassignRequestedBy: { name: String, email: String },
}, { timestamps: true });

// ── Chat history ─────────────────────────────────────────────────────────────
const ChatHistorySchema = new Schema({
  userId:   { type: String, required: true, unique: true, index: true },
  messages: [{ role: { type: String, enum: ['user', 'assistant'] }, content: String }],
}, { timestamps: true });

// ── Command (Orders) history ──────────────────────────────────────────────────
const CommandHistorySchema = new Schema({
  userId: { type: String, required: true, unique: true, index: true },
  turns:  [Schema.Types.Mixed],
}, { timestamps: true });

// ── Notification ──────────────────────────────────────────────────────────────
const NotificationSchema = new Schema({
  targetUserIds: [String],   // user _id strings
  type:    { type: String, enum: ['info', 'warn', 'error', 'success'], default: 'info' },
  message: { type: String, required: true },
  data:    Schema.Types.Mixed,
  readBy:  [String],          // user _id strings who read it
}, { timestamps: true });

module.exports = {
  User:               mongoose.model('User',               UserSchema),
  ApprovalHistory:    mongoose.model('ApprovalHistory',    ApprovalHistorySchema),
  EscalationHistory:  mongoose.model('EscalationHistory',  EscalationHistorySchema),
  Notification:       mongoose.model('Notification',       NotificationSchema),
  ChatHistory:        mongoose.model('ChatHistory',        ChatHistorySchema),
  CommandHistory:     mongoose.model('CommandHistory',     CommandHistorySchema),
};
