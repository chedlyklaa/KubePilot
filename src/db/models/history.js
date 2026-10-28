const mongoose = require('mongoose');
const { Schema } = mongoose;

const ApprovalHistorySchema = new Schema({
  issueKey:    { type: String, required: true },
  issue:       Schema.Types.Mixed,
  diagnosis:   Schema.Types.Mixed,
  decision:    { type: String, enum: ['approved', 'denied', 'timeout', 'silenced'], required: true },
  decidedBy:   { userId: String, name: String, email: String, role: String },
  requestedAt: Date,
  overrideReasons: [String],
  preferredAction: String,
  adminNote:       String,
}, { timestamps: true });

const EscalationHistorySchema = new Schema({
  issueKey:      { type: String, required: true },
  issue:         Schema.Types.Mixed,
  cluster:       { type: String, default: '' },
  node:          { type: String, default: '' },
  attempts:      Number,
  failedHistory: [Schema.Types.Mixed],
  escalatedAt:   { type: Date, default: Date.now },
  rca:           Schema.Types.Mixed,

  status: {
    type: String,
    enum: ['pending', 'acknowledged', 'in_progress', 'fixed', 'not_fixed', 'need_help'],
    default: 'pending',
  },
  stateUpdatedAt:  Date,
  stateUpdatedBy:  { name: String, email: String, role: String },

  acknowledgedBy:  { userId: String, name: String, email: String, role: String },
  acknowledgedAt:  Date,

  assignedTo:   { userId: String, name: String, email: String, role: String },
  assignedAt:   Date,
  assignedBy:   { name: String, email: String },

  reassignRequested:   { type: Boolean, default: false },
  reassignRequestedAt: Date,
  reassignRequestedBy: { name: String, email: String },

  lastTeamsNotif: Date,
}, { timestamps: true });

const ChatHistorySchema = new Schema({
  userId:   { type: String, required: true, unique: true, index: true },
  messages: [{ role: { type: String, enum: ['user', 'assistant'] }, content: String }],
}, { timestamps: true });

const CommandHistorySchema = new Schema({
  userId: { type: String, required: true, unique: true, index: true },
  turns:  [Schema.Types.Mixed],
}, { timestamps: true });

const SilenceRuleSchema = new Schema({
  key:       { type: String, required: true },
  until:     { type: Date, required: true, index: true },
  reason:    { type: String, default: '' },
  createdBy: { name: String, email: String, role: String },
}, { timestamps: true });

const IssueTrackerSchema = new Schema({
  seq:         { type: Number, required: true, unique: true, index: true },
  issueKey:    { type: String, required: true, index: true },
  issueType:   String,
  cluster:     String,
  tier:        String,
  namespace:   String,
  resource:    String,
  fingerprint: Schema.Types.Mixed,
  rca:         Schema.Types.Mixed,
  workflowId:  { type: String, index: true },
  status: {
    type: String,
    enum: ['detected', 'investigating', 'awaiting_approval', 'approved', 'blocked', 'skipped', 'failed', 'success', 'escalated', 'fixed'],
    default: 'detected',
  },
  timeline: [{
    stage:           String,
    action:          String,
    outcome:         String,
    guardianVerdict: String,
    note:            String,
    at:              { type: Date, default: Date.now },
  }],
  resolvedAt: Date,
}, { timestamps: true });

const WorkflowTraceSchema = new Schema({
  workflowId:   { type: String, required: true, unique: true, index: true },
  pipeline:     { type: String, enum: ['legacy', 'v5'], default: 'v5' },
  issueKeys:    [String],
  cluster:      String,
  namespace:    String,
  incidentType: String,
  complexity:   { type: String, enum: ['SIMPLE', 'COMPLEX', 'UNKNOWN'], default: 'UNKNOWN' },
  startedAt:      Date,
  endedAt:        Date,
  totalLatencyMs: Number,
  nodes:          Schema.Types.Mixed,
  totalLlmCalls:  Number,
  totalToolCalls: Number,
  investigationTurns:     Number,
  ringsVisited:           [Number],
  layersInvestigated:     [String],
  hypothesisHistory:      Schema.Types.Mixed,
  confidenceHistory:      [Number],
  reachedConfidenceTarget: Boolean,
  bestHypothesis:         Schema.Types.Mixed,
  nonImprovingRounds:     Number,
  stoppingOutcome: {
    type: String,
    enum: ['DIAGNOSIS_READY', 'MORE_INVESTIGATION_REQUIRED', 'INVESTIGATION_BUDGET_EXHAUSTED', 'INCONCLUSIVE'],
  },
  informationGainHistory: [{ type: String, enum: ['NONE', 'LOW', 'MEDIUM', 'HIGH'] }],
  plannerTurns:                   Number,
  plannerToInvestigatorRequests:  Number,
  plannerDryRunCalls:             Number,
  fastPathUsed:      Boolean,
  fastPathEscalated: Boolean,
  guardianRejections:     Number,
  policyRejections:       Number,
  humanApprovalRequests:  Number,
  humanEscalations:       Number,
  tokenUsage:             Schema.Types.Mixed,
  finalOutcome: { type: String, enum: ['fixed', 'blocked', 'escalated'] },
}, { timestamps: true });

module.exports = {
  ApprovalHistory:   mongoose.model('ApprovalHistory',   ApprovalHistorySchema),
  EscalationHistory: mongoose.model('EscalationHistory', EscalationHistorySchema),
  ChatHistory:       mongoose.model('ChatHistory',       ChatHistorySchema),
  CommandHistory:    mongoose.model('CommandHistory',    CommandHistorySchema),
  SilenceRule:       mongoose.model('SilenceRule',       SilenceRuleSchema),
  IssueTracker:      mongoose.model('IssueTracker',      IssueTrackerSchema),
  WorkflowTrace:     mongoose.model('WorkflowTrace',     WorkflowTraceSchema),
};
