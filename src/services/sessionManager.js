'use strict';
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const crypto = require('crypto');
const yaml   = require('js-yaml');
const { execFile } = require('child_process');
const notifCrypto = require('./notifications/crypto');
const { ClusterCredential } = require('../db/models');

const RUNTIME_DIR = path.join(os.tmpdir(), 'kubepilot-runtime');

const _cache = new Map();

function initRuntimeDir() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(RUNTIME_DIR, 0o700); } catch { }
  for (const f of fs.readdirSync(RUNTIME_DIR)) {
    try { fs.unlinkSync(path.join(RUNTIME_DIR, f)); } catch { }
  }
}

// Build the context name for an uploaded cluster
function canonicalContext(clusterName) {
  const safe = clusterName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return `kp-${safe}`;
}

// Extract the single context from a kubeconfig
function _extractSingleContext(rawText) {
  let cfg;
  try { cfg = yaml.load(rawText); }
  catch (err) { throw new Error(`Kubeconfig is not valid YAML: ${err.message}`); }

  const contexts = cfg?.contexts ?? [];
  if (contexts.length !== 1) {
    throw new Error(
      `Kubeconfig must contain exactly one context (found ${contexts.length}). ` +
      `Export a single-cluster kubeconfig before uploading, e.g.: kubectl config view --minify --flatten`
    );
  }
  const ctxEntry     = contexts[0];
  const clusterEntry = (cfg.clusters ?? []).find(c => c.name === ctxEntry.context.cluster);
  const userEntry    = (cfg.users    ?? []).find(u => u.name === ctxEntry.context.user);
  if (!clusterEntry || !userEntry)
    throw new Error('Kubeconfig is missing the cluster or user entry referenced by its context');

  return { ctxEntry, clusterEntry, userEntry };
}

// Rename the kubeconfig entries
function _buildNormalizedYaml({ ctxEntry, clusterEntry, userEntry }, canonicalName) {
  return yaml.dump({
    apiVersion: 'v1',
    kind: 'Config',
    'current-context': canonicalName,
    clusters: [{ name: canonicalName, cluster: clusterEntry.cluster }],
    users:    [{ name: canonicalName, user: userEntry.user }],
    contexts: [{
      name: canonicalName,
      context: { cluster: canonicalName, user: canonicalName, namespace: ctxEntry.context.namespace ?? 'default' },
    }],
  });
}

function normalizeKubeconfig(rawText, canonicalName) {
  return _buildNormalizedYaml(_extractSingleContext(rawText), canonicalName);
}

// Test the connection to a cluster
async function testConnection(rawText) {
  _extractSingleContext(rawText);

  const dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-test-'));
  const file = path.join(dir, 'kubeconfig.yaml');
  try {
    fs.writeFileSync(file, rawText, { mode: 0o600 });
    await new Promise((resolve, reject) => {
      execFile(
        'kubectl',
        ['--kubeconfig', file, '--request-timeout=10s', 'cluster-info'],
        { timeout: 15_000 },
        (error, stdout, stderr) => {
          if (error) {
            const msg = stderr?.trim() || error.message || 'Could not connect to the cluster';
            return reject(new Error(msg));
          }
          resolve(stdout);
        }
      );
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function _materialize(encryptedConfig, context) {
  const { kubeconfig } = notifCrypto.decrypt(encryptedConfig);
  if (!kubeconfig) throw new Error(`Stored credential for "${context}" could not be decrypted`);
  const filePath = path.join(RUNTIME_DIR, `${crypto.randomUUID()}.yaml`);
  fs.writeFileSync(filePath, kubeconfig, { mode: 0o600 });
  try { fs.chmodSync(filePath, 0o600); } catch { }
  return filePath;
}

// Get the kubeconfig path for a context
async function getKubeconfigPath(context) {
  const cached = _cache.get(context);
  if (cached) return cached.path;

  const cred = await ClusterCredential.findOne({ context }).lean();
  if (!cred) return null;

  const filePath = _materialize(cred.encryptedConfig, context);
  _cache.set(context, { version: cred.version, path: filePath });
  return filePath;
}

// Clear the cached kubeconfig for a context
function invalidate(context) {
  const cached = _cache.get(context);
  if (!cached) return;
  try { fs.unlinkSync(cached.path); } catch { }
  _cache.delete(context);
}

// Store a cluster credential
async function storeCredential({ name, rawKubeconfig, uploadedBy }) {
  const context   = canonicalContext(name);
  const extracted = _extractSingleContext(rawKubeconfig);
  const server    = extracted.clusterEntry.cluster.server;

  const duplicate = await ClusterCredential.findOne({ server, context: { $ne: context } }).select('clusterName').lean();
  if (duplicate) {
    throw new Error(
      `This cluster (${server}) is already registered as "${duplicate.clusterName}". ` +
      `Delete that entry first if you want to re-add it under a different name.`
    );
  }

  const normalized = _buildNormalizedYaml(extracted, context);
  await testConnection(normalized);
  const encryptedConfig = notifCrypto.encrypt({ kubeconfig: normalized });

  const existing = await ClusterCredential.findOne({ context }).select('version').lean();
  const version = (existing?.version ?? 0) + 1;

  try {
    await ClusterCredential.findOneAndUpdate(
      { context },
      { context, clusterName: name, server, encryptedConfig, version, uploadedBy },
      { upsert: true }
    );
  } catch (err) {
    if (err.code === 11000) throw new Error(`This cluster (${server}) is already registered under a different name.`);
    throw err;
  }
  invalidate(context);
  return context;
}

// Delete a cluster credential
async function deleteCredential(context) {
  invalidate(context);
  await ClusterCredential.deleteOne({ context });
}

module.exports = {
  initRuntimeDir,
  canonicalContext,
  normalizeKubeconfig,
  testConnection,
  getKubeconfigPath,
  invalidate,
  storeCredential,
  deleteCredential,
};
