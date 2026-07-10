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

// ── User Certificate (client-cert kubectl access, per user per cluster) ──────
// Issued via the K8s CertificateSigningRequest API (see services/certIssuer.js).
// commonName mirrors the user's email — the same identity string already used as
// the RoleBinding subject for impersonation (kubectl --as=email), so one set of
// RoleBindings authorizes both impersonation AND this cert.
const UserCertificateSchema = new Schema({
  userId:       { type: String, required: true },
  cluster:      { type: String, required: true },          // cluster name (clusters.yaml), not context
  commonName:   { type: String, required: true },          // == user's email
  certPem:      { type: String, required: true },          // signed client certificate (not secret)
  encryptedKey: { type: String, required: true },           // AES-256-GCM encrypted private key PEM
  csrName:      { type: String, default: null },            // k8s CertificateSigningRequest object name (audit trail)
  issuedAt:     { type: Date, default: Date.now },
  expiresAt:    { type: Date, default: null },
}, { timestamps: true });

UserCertificateSchema.index({ userId: 1, cluster: 1 }, { unique: true }); // re-issuing replaces the previous cert

module.exports = {
  Group:            mongoose.model('Group',            GroupSchema),
  User:             mongoose.model('User',              UserSchema),
  UserCertificate:  mongoose.model('UserCertificate',   UserCertificateSchema),
};
