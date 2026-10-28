const mongoose = require('mongoose');
const { Schema } = mongoose;

const IncidentEpisodeSchema = new Schema({
  fingerprint: {
    issueType:    { type: String, required: true, index: true },
    oomKilled:    { type: Boolean, default: false },
    exitCode:     { type: Number, default: null },
    hasDeployment:{ type: Boolean, default: true },
    tier:         { type: String, default: 'dev' },
    imagePrefix:  { type: String, default: '' },
  },

  context: {
    cluster:      String,
    namespace:    String,
    deployment:   String,
    pod:          String,
    restartCount: Number,
    logSnippet:   String,
  },

  timeline: [{
    action:         String,
    outcome:        { type: String, enum: ['success', 'fixed', 'failed', 'blocked', 'skipped', 'escalated'] },
    guardianVerdict:String,
    note:           String,
    at:             { type: Date, default: Date.now },
  }],

  reflection: {
    rootCause:      String,
    lessonsLearned: String,
    suggestedRule:  String,
    confidence:     Number,
  },

  resolved:       { type: Boolean, default: false },
  resolvedAction: String,
  totalAttempts:  Number,

  qdrantId: String,

  overrideReasons: [String],
  preferredAction: String,
  adminNote:       String,

  rca: {
    suspected_cause:   String,
    confidence:        Number,
    evidence:          [String],
    recommended_focus: String,
    risk_level:        String,
  },

  guardianClassification: { type: String, default: null },

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

const LearnedRuleSchema = new Schema({
  issueType:   { type: String, required: true, index: true },
  condition:   { type: String, required: true },
  rule:        { type: String, required: true },
  source:      { type: String, enum: ['pattern_detected', 'manual'], default: 'pattern_detected' },
  occurrences: { type: Number, default: 1 },
  confidence:  { type: Number, default: 0.5 },
  active:      { type: Boolean, default: true, index: true },
}, { timestamps: true });

const MetricSnapshotSchema = new Schema({
  cluster:    { type: String, required: true, index: true },
  namespace:  { type: String, default: '' },
  target:     { type: String, required: true },
  targetType: { type: String, enum: ['pod', 'node', 'namespace'], required: true },
  cpuPct:     { type: Number, default: null },
  memPct:     { type: Number, default: null },
  diskPct:    { type: Number, default: null },
  cpuAbs:     { type: Number, default: null },
  memAbs:     { type: Number, default: null },
}, { timestamps: true });

MetricSnapshotSchema.index({ cluster: 1, target: 1, createdAt: 1 });
MetricSnapshotSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });

const CapacityForecastCacheSchema = new Schema({
  cluster:    { type: String, required: true, unique: true, index: true },
  forecast:   { type: Schema.Types.Mixed, default: null },
  computedAt: { type: Date, default: Date.now },
}, { timestamps: true });

const TemporalEventSchema = new Schema({
  timestamp: { type: String, required: true },
  cluster:   String,
  action:    String,
  status:    String,
  issue:     String,
  riskScore: { type: Number, default: 0 },
  metadata:  Schema.Types.Mixed,
}, { timestamps: true });

TemporalEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

module.exports = {
  IncidentEpisode:       mongoose.model('IncidentEpisode',       IncidentEpisodeSchema),
  LearnedRule:           mongoose.model('LearnedRule',           LearnedRuleSchema),
  MetricSnapshot:        mongoose.model('MetricSnapshot',        MetricSnapshotSchema),
  CapacityForecastCache: mongoose.model('CapacityForecastCache', CapacityForecastCacheSchema),
  TemporalEvent:         mongoose.model('TemporalEvent',         TemporalEventSchema),
};
