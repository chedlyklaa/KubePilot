const mongoose = require('mongoose');
const { Schema } = mongoose;

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

module.exports = {
  IncidentEpisode:       mongoose.model('IncidentEpisode',       IncidentEpisodeSchema),
  LearnedRule:           mongoose.model('LearnedRule',           LearnedRuleSchema),
  MetricSnapshot:        mongoose.model('MetricSnapshot',        MetricSnapshotSchema),
  CapacityForecastCache: mongoose.model('CapacityForecastCache', CapacityForecastCacheSchema),
  TemporalEvent:         mongoose.model('TemporalEvent',         TemporalEventSchema),
};
