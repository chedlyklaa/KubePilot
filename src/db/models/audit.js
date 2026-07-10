const mongoose = require('mongoose');
const { Schema } = mongoose;

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

module.exports = {
  AuditEvent:      mongoose.model('AuditEvent',      AuditEventSchema),
  RbacAuditLog:    mongoose.model('RbacAuditLog',    RbacAuditLogSchema),
  NetworkAuditLog: mongoose.model('NetworkAuditLog', NetworkAuditLogSchema),
};
