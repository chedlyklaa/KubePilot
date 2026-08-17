const mongoose = require('mongoose');
const { Schema } = mongoose;

// ── Approval history ──────────────────────────────────────────────────────────
const ApprovalHistorySchema = new Schema({
  issueKey:    { type: String, required: true },
  issue:       Schema.Types.Mixed,
  diagnosis:   Schema.Types.Mixed,
  decision:    { type: String, enum: ['approved', 'denied', 'timeout', 'silenced'], required: true },
  decidedBy:   { userId: String, name: String, email: String, role: String },
  requestedAt: Date,
  // Counterfactual override feedback (populated on denial only)
  overrideReasons: [String],
  preferredAction: String,
  adminNote:       String,
}, { timestamps: true });

// ── Escalation history ────────────────────────────────────────────────────────
// States: pending → acknowledged → in_progress → fixed | not_fixed | need_help
const EscalationHistorySchema = new Schema({
  issueKey:      { type: String, required: true },
  issue:         Schema.Types.Mixed,
  cluster:       { type: String, default: '' },
  node:          { type: String, default: '' },
  attempts:      Number,
  failedHistory: [Schema.Types.Mixed],
  escalatedAt:   { type: Date, default: Date.now },
  rca:           Schema.Types.Mixed,

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

  // Timestamp of the last Teams notification sent for this escalation.
  // Persisted so the 30-min rate-limit survives server restarts.
  lastTeamsNotif: Date,
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

// ── Silence Rule ─────────────────────────────────────────────────────────────
// One document per active silence. Expired docs are not auto-deleted here —
// the store filters by `until > now` and silenceStore.init() skips old docs.
const SilenceRuleSchema = new Schema({
  key:       { type: String, required: true },          // agent key: "type:target:ns"
  until:     { type: Date, required: true, index: true },
  reason:    { type: String, default: '' },
  createdBy: { name: String, email: String, role: String },
}, { timestamps: true });

// ── Issue tracker ─────────────────────────────────────────────────────────────
// One document per remediation episode — from first detection through to fixed/
// still-retrying — so a user who clicks Approve can look up what happened next.
// `seq` is the human-facing id (#1042); `issueKey` is the agent's own dedupe key
// ("type:target:namespace") and is how this doc gets found again on later stages
// of the same episode (see issueTrackerStore.js).
const IssueTrackerSchema = new Schema({
  seq:         { type: Number, required: true, unique: true, index: true },
  issueKey:    { type: String, required: true, index: true },
  issueType:   String,
  cluster:     String,
  tier:        String,
  namespace:   String,
  resource:    String,   // pod / deployment / node name
  fingerprint: Schema.Types.Mixed,
  rca:         Schema.Types.Mixed,
  status: {
    type: String,
    // detected → investigating → awaiting_approval → approved → (blocked|skipped|failed|success)* → fixed
    //                                                                                             → escalated
    enum: ['detected', 'investigating', 'awaiting_approval', 'approved', 'blocked', 'skipped', 'failed', 'success', 'escalated', 'fixed'],
    default: 'detected',
  },
  timeline: [{
    stage:           String,   // detected | investigated | awaiting_approval | approved | progress | escalated | resolved
    action:          String,
    outcome:         String,
    guardianVerdict: String,
    note:            String,
    at:              { type: Date, default: Date.now },
  }],
  resolvedAt: Date,
}, { timestamps: true });

module.exports = {
  ApprovalHistory:   mongoose.model('ApprovalHistory',   ApprovalHistorySchema),
  EscalationHistory: mongoose.model('EscalationHistory', EscalationHistorySchema),
  ChatHistory:       mongoose.model('ChatHistory',       ChatHistorySchema),
  CommandHistory:    mongoose.model('CommandHistory',    CommandHistorySchema),
  SilenceRule:       mongoose.model('SilenceRule',       SilenceRuleSchema),
  IssueTracker:      mongoose.model('IssueTracker',      IssueTrackerSchema),
};
