'use strict';
const mongoose = require('mongoose');
const { Schema } = mongoose;

// Encrypted per-cluster kubeconfig — the credential-isolation half of the hybrid
// kubeconfig-upload feature (see services/sessionManager.js). `context` is the
// canonical, collision-free identifier written into clusters.yaml for this cluster;
// it does NOT need to exist in the server's shared kubeconfig file, since
// sessionManager materializes a private, minified kubeconfig for it on demand.
const ClusterCredentialSchema = new Schema({
  context:         { type: String, required: true, unique: true },
  clusterName:     { type: String, required: true },
  // Server URL, not secret by itself (same reasoning kubectl.js's getClusterConnectionInfo
  // already applies to server/CA data) — stored in the clear so duplicate uploads of the
  // same physical cluster under a different name can be detected without decrypting
  // every existing credential just to compare.
  server:          { type: String, required: true, unique: true },
  encryptedConfig: { type: String, required: true },
  version:         { type: Number, required: true },
  uploadedBy:      { type: String, default: null },
}, { timestamps: true });

module.exports = {
  ClusterCredential: mongoose.model('ClusterCredential', ClusterCredentialSchema),
};
