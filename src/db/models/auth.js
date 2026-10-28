const mongoose = require('mongoose');
const { Schema } = mongoose;

const PermissionScopeSchema = new Schema({
  cluster:   { type: String, required: true },
  namespace: { type: String, default: '*' },
  role:      { type: String, enum: ['viewer', 'editor', 'admin'], default: 'viewer' },
}, { _id: false });

const GroupSchema = new Schema({
  name:        { type: String, required: true, unique: true, trim: true },
  description: { type: String, default: '' },
  permissions: [PermissionScopeSchema],
}, { timestamps: true });

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

const UserCertificateSchema = new Schema({
  userId:       { type: String, required: true },
  cluster:      { type: String, required: true },
  commonName:   { type: String, required: true },
  certPem:      { type: String, required: true },
  encryptedKey: { type: String, required: true },
  csrName:      { type: String, default: null },
  issuedAt:     { type: Date, default: Date.now },
  expiresAt:    { type: Date, default: null },
}, { timestamps: true });

UserCertificateSchema.index({ userId: 1, cluster: 1 }, { unique: true });

module.exports = {
  Group:            mongoose.model('Group',            GroupSchema),
  User:             mongoose.model('User',              UserSchema),
  UserCertificate:  mongoose.model('UserCertificate',   UserCertificateSchema),
};
