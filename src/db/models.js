const mongoose = require('mongoose');
const { Schema } = mongoose;

// ── Permission scope (reused in User + Group) ───────────────────────────────
const PermissionScopeSchema = new Schema({
  cluster:   { type: String, required: true },            // cluster name or '*'
  namespace: { type: String, default: '*' },              // namespace or '*'
  role:      { type: String, enum: ['viewer', 'editor', 'admin'], default: 'viewer' },
}, { _id: false });

// ── Group (team-based permissions) ───────────────────────────────────────────
const GroupSchema = new Schema({
  name:        { type: String, required: true, unique: true, trim: true },
  description: { type: String, default: '' },
  permissions: [PermissionScopeSchema],
}, { timestamps: true });

// ── User ──────────────────────────────────────────────────────────────────────
const UserSchema = new Schema({
  email:       { type: String, required: true, unique: true, lowercase: true, trim: true },
  password:    { type: String, required: true },
  name:        { type: String, required: true, trim: true },
  role:        { type: String, enum: ['admin', 'developer'], default: 'developer' },
  active:       { type: Boolean, default: true },
  canProvision: { type: Boolean, default: false },
  permissions:  [PermissionScopeSchema],
  group:        { type: Schema.Types.ObjectId, ref: 'Group', default: null },
}, { timestamps: true });

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

// ── Notification ──────────────────────────────────────────────────────────────
const NotificationSchema = new Schema({
  targetUserIds: [String],   // user _id strings
  type:    { type: String, enum: ['info', 'warn', 'error', 'success'], default: 'info' },
  message: { type: String, required: true },
  data:    Schema.Types.Mixed,
  readBy:  [String],          // user _id strings who read it
}, { timestamps: true });

// ── Incident Episode (self-improving memory) ──────────────────────────────────
// One document per resolved or escalated incident.
// Accumulated across multiple fix attempts within the same incident lifecycle.
const IncidentEpisodeSchema = new Schema({
  // Structural fingerprint — used for fast in-memory index lookup
  fingerprint: {
    issueType:    { type: String, required: true, index: true },
    oomKilled:    { type: Boolean, default: false },
    exitCode:     { type: Number, default: null },
    hasDeployment:{ type: Boolean, default: true },
    tier:         { type: String, default: 'dev' },
    imagePrefix:  { type: String, default: '' },
  },

  // Execution context captured at incident start
  context: {
    cluster:      String,
    namespace:    String,
    deployment:   String,
    pod:          String,
    restartCount: Number,
    logSnippet:   String,   // last 500 chars of pod logs
  },

  // Ordered list of actions attempted during this incident
  timeline: [{
    action:         String,
    outcome:        { type: String, enum: ['success', 'failed', 'blocked', 'skipped'] },
    guardianVerdict:String,
    note:           String,
    at:             { type: Date, default: Date.now },
  }],

  // Reflection Agent output — extracted after the incident concludes
  reflection: {
    rootCause:      String,
    lessonsLearned: String,
    suggestedRule:  String,
    confidence:     Number,
  },

  resolved:       { type: Boolean, default: false },
  resolvedAction: String,     // the action that finally worked, or null
  totalAttempts:  Number,

  qdrantId: String,           // UUID of the corresponding vector in Qdrant

  // Counterfactual override feedback from admin denial — optional, no migration needed
  overrideReasons: [String],
  preferredAction: String,
  adminNote:       String,

  // InvestigatorAgent RCA produced before the planner ran — optional, no migration needed
  rca: {
    suspected_cause:   String,
    confidence:        Number,
    evidence:          [String],
    recommended_focus: String,
    risk_level:        String,
  },

  // GuardianAgent classification — stored for richer Qdrant payload (optional)
  guardianClassification: { type: String, default: null },

  // Prometheus metrics captured at the time of the incident (null when unavailable)
  metricsSnapshot: {
    cpu: {
      avgCores:  Number,
      peakCores: Number,
      avgPct:    Number,
      peakPct:   Number,
      trend:     String,
    },
    memory: {
      avgMi:  Number,
      peakMi: Number,
      trend:  String,
    },
    restarts: {
      count: Number,
    },
    oomDetected: Boolean,
    collectedAt: Date,
  },
}, { timestamps: true });

// ── Learned Rule ──────────────────────────────────────────────────────────────
// Auto-generated from repeated failure patterns.
// Injected into PlannerAgent prompts to prevent known-bad decisions.
const LearnedRuleSchema = new Schema({
  issueType:   { type: String, required: true, index: true },
  condition:   { type: String, required: true },   // human-readable trigger condition
  rule:        { type: String, required: true },   // the constraint or guidance
  source:      { type: String, enum: ['pattern_detected', 'manual'], default: 'pattern_detected' },
  occurrences: { type: Number, default: 1 },
  confidence:  { type: Number, default: 0.5 },
  active:      { type: Boolean, default: true, index: true },
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

// ── Metric Snapshot (capacity forecasting time-series) ───────────────────────
// One document per scrape point per target. TTL 30 days keeps collection bounded.
const MetricSnapshotSchema = new Schema({
  cluster:    { type: String, required: true, index: true },
  namespace:  { type: String, default: '' },
  target:     { type: String, required: true },        // "pod:name" | "node:name" | "ns:name"
  targetType: { type: String, enum: ['pod', 'node', 'namespace'], required: true },
  cpuPct:     { type: Number, default: null },         // 0–100
  memPct:     { type: Number, default: null },         // 0–100
  diskPct:    { type: Number, default: null },         // 0–100 (nodes only)
  cpuAbs:     { type: Number, default: null },         // cores (pods) or raw pct (nodes)
  memAbs:     { type: Number, default: null },         // bytes
}, { timestamps: true });

MetricSnapshotSchema.index({ cluster: 1, target: 1, createdAt: 1 });
MetricSnapshotSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });

// ── Capacity Forecast Cache (latest forecast per cluster) ─────────────────────
// One document per cluster — upserted each time a forecast runs.
const CapacityForecastCacheSchema = new Schema({
  cluster:    { type: String, required: true, unique: true, index: true },
  forecast:   { type: Schema.Types.Mixed, default: null },
  computedAt: { type: Date, default: Date.now },
}, { timestamps: true });

// ── Temporal Event (persisted short-term action history) ─────────────────────
const TemporalEventSchema = new Schema({
  timestamp: { type: String, required: true },
  cluster:   String,
  action:    String,
  status:    String,
  issue:     String,
  riskScore: { type: Number, default: 0 },
  metadata:  Schema.Types.Mixed,
}, { timestamps: true });

// Auto-delete after 7 days — keeps the collection bounded without manual cleanup
TemporalEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

// ── Audit Event (queryable audit trail alongside JSONL file) ─────────────────
const AuditEventSchema = new Schema({
  timestamp: { type: String, required: true },
  cluster:   { type: String, default: 'unknown' },
  agent:     { type: String, default: 'unknown' },
  action:    { type: String, default: 'unknown' },
  decision:  { type: String, default: 'unknown' },
  riskScore: { type: Number, default: 0 },
  status:    { type: String, default: 'pending' },
  reason:    String,
  metadata:  Schema.Types.Mixed,
}, { timestamps: true });

// ── RBAC Audit Log ────────────────────────────────────────────────────────────
// One document per successful apply or delete via the RBAC management UI.
const RbacAuditLogSchema = new Schema({
  userId:    { type: String, required: true },
  userEmail: { type: String, required: true },
  action:    { type: String, enum: ['apply', 'delete'], required: true },
  kind:      String,
  name:      String,
  namespace: String,
  context:   { type: String, required: true },
  yaml:      String,   // populated for apply only
  timestamp: { type: Date, default: Date.now },
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

// ── Network Audit Log ─────────────────────────────────────────────────────────
// One document per successful apply or delete via the Network management UI.
const NetworkAuditLogSchema = new Schema({
  userId:    { type: String, required: true },
  userEmail: { type: String, required: true },
  action:    { type: String, enum: ['apply', 'delete'], required: true },
  kind:      String,
  name:      String,
  namespace: String,
  context:   { type: String, required: true },
  yaml:      String,
  timestamp: { type: Date, default: Date.now },
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
  Group:                       mongoose.model('Group',                       GroupSchema),
  MetricSnapshot:              mongoose.model('MetricSnapshot',              MetricSnapshotSchema),
  CapacityForecastCache:       mongoose.model('CapacityForecastCache',       CapacityForecastCacheSchema),
  User:                        mongoose.model('User',                        UserSchema),
  ApprovalHistory:             mongoose.model('ApprovalHistory',             ApprovalHistorySchema),
  EscalationHistory:           mongoose.model('EscalationHistory',           EscalationHistorySchema),
  TemporalEvent:               mongoose.model('TemporalEvent',               TemporalEventSchema),
  AuditEvent:                  mongoose.model('AuditEvent',                  AuditEventSchema),
  Notification:                mongoose.model('Notification',                NotificationSchema),
  ChatHistory:                 mongoose.model('ChatHistory',                 ChatHistorySchema),
  CommandHistory:              mongoose.model('CommandHistory',              CommandHistorySchema),
  IncidentEpisode:             mongoose.model('IncidentEpisode',             IncidentEpisodeSchema),
  LearnedRule:                 mongoose.model('LearnedRule',                 LearnedRuleSchema),
  RbacAuditLog:                     mongoose.model('RbacAuditLog',                     RbacAuditLogSchema),
  NetworkAuditLog:                  mongoose.model('NetworkAuditLog',                  NetworkAuditLogSchema),
  NotificationChannelConfig:        mongoose.model('NotificationChannelConfig',        NotificationChannelConfigSchema),
  NotificationRoutingConfig:        mongoose.model('NotificationRoutingConfig',        NotificationRoutingConfigSchema),
  NotificationDeliveryLog:          mongoose.model('NotificationDeliveryLog',          NotificationDeliveryLogSchema),
  UserNotificationPreferences:      mongoose.model('UserNotificationPreferences',      UserNotificationPreferencesSchema),
  SilenceRule:                      mongoose.model('SilenceRule',                      SilenceRuleSchema),
};
