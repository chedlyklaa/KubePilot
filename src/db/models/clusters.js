'use strict';
const mongoose = require('mongoose');
const { Schema } = mongoose;

const ClusterCredentialSchema = new Schema({
  context:         { type: String, required: true, unique: true },
  clusterName:     { type: String, required: true },
  server:          { type: String, required: true, unique: true },
  encryptedConfig: { type: String, required: true },
  version:         { type: Number, required: true },
  uploadedBy:      { type: String, default: null },
}, { timestamps: true });

module.exports = {
  ClusterCredential: mongoose.model('ClusterCredential', ClusterCredentialSchema),
};
