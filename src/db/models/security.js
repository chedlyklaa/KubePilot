const mongoose = require('mongoose');
const { Schema } = mongoose;

// ── Security Finding (standing-state security posture) ───────────────────────
// Unlike IncidentEpisode (one document per resolved/escalated transient incident),
// a security finding describes a state that stays true until someone changes the
// cluster or explicitly accepts the risk — so this is upserted per (cluster, kind,
// findingKey) rather than appended, and carries its own status lifecycle instead of
// the pod-pipeline's cooldown/attempt-count model. One collection for every finding
// family (RBAC posture, workload hardening, network exposure, secrets hygiene) keeps
// the Security Overview page to a single query.
const SecurityFindingSchema = new Schema({
  cluster:   { type: String, required: true, index: true },
  namespace: { type: String, default: null },
  kind: {
    type: String,
    enum: ['RbacPosture', 'WorkloadHardening', 'NetworkExposure', 'SecretsHygiene'],
    required: true,
    index: true,
  },

  // Stable identity for this exact finding on this exact resource — what upsert
  // dedupes on and what a re-scan uses to tell "still true" from "gone now".
  findingKey: { type: String, required: true },

  severity: { type: String, enum: ['low', 'medium', 'high', 'critical'], default: 'medium', index: true },

  resource: {
    kind:      String,
    name:      String,
    namespace: String,
  },

  description: { type: String, required: true },
  cisControl:  { type: String, default: null },

  // open      → detected, not yet reviewed
  // silenced  → temporarily muted (mirrors src/api/silenceStore.js)
  // accepted  → human reviewed and decided the risk is acceptable (permanent, with a reason)
  // resolved  → not seen on the most recent scan (the underlying cause appears fixed)
  status: { type: String, enum: ['open', 'silenced', 'accepted', 'resolved'], default: 'open', index: true },

  acceptedBy: {
    userId: String,
    name:   String,
    email:  String,
  },
  acceptedReason: { type: String, default: null },

  detectedAt: { type: Date, default: Date.now },
  lastSeenAt: { type: Date, default: Date.now },
}, { timestamps: true });

SecurityFindingSchema.index({ cluster: 1, kind: 1, findingKey: 1 }, { unique: true });

module.exports = {
  SecurityFinding: mongoose.model('SecurityFinding', SecurityFindingSchema),
};
