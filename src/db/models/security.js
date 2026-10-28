const mongoose = require('mongoose');
const { Schema } = mongoose;

const SecurityFindingSchema = new Schema({
  cluster:   { type: String, required: true, index: true },
  namespace: { type: String, default: null },
  kind: {
    type: String,
    enum: ['RbacPosture', 'WorkloadHardening', 'NetworkExposure', 'SecretsHygiene'],
    required: true,
    index: true,
  },

  findingKey: { type: String, required: true },

  severity: { type: String, enum: ['low', 'medium', 'high', 'critical'], default: 'medium', index: true },

  resource: {
    kind:      String,
    name:      String,
    namespace: String,
  },

  description: { type: String, required: true },
  cisControl:  { type: String, default: null },

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
