'use strict';

const os        = require('os');
const path      = require('path');
const fs        = require('fs');
const { execFile } = require('child_process');
const yamlLib   = require('js-yaml');
const kubectl   = require('../tools/kubectl');
const rbacSync  = require('./rbacSync');
const notifCrypto = require('./notifications/crypto');
const { User, UserCertificate } = require('../db/models');
const { getClusters } = require('../config/clusterConfig');

function _sanitize(str) {
  return str.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
}

function _execFile(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr?.trim() || err.message));
      resolve(stdout);
    });
  });
}

// Generate a key and CSR
async function _generateKeyAndCsr(commonName) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-cert-'));
  const keyPath = path.join(dir, 'client.key');
  const csrPath = path.join(dir, 'client.csr');
  try {
    await _execFile('openssl', ['genrsa', '-out', keyPath, '2048']);
    await _execFile('openssl', ['req', '-new', '-key', keyPath, '-out', csrPath, '-subj', `/CN=${commonName}`]);
    return {
      keyPem: fs.readFileSync(keyPath, 'utf8'),
      csrPem: fs.readFileSync(csrPath, 'utf8'),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Wait for the signed certificate
async function _pollForCertificate(csrName, context, { attempts = 10, delayMs = 500 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const certB64 = await kubectl.getCsrCertificate(csrName, context);
    if (certB64) return certB64;
    await new Promise(r => setTimeout(r, delayMs));
  }
  throw new Error(`Certificate for CSR "${csrName}" was not issued within ${(attempts * delayMs) / 1000}s — check that the cluster's signer controller is running and the CSR was approved`);
}

function _buildKubeconfig({ context, clusterInfo, commonName, certPemB64, keyPemB64 }) {
  const clusterEntry = clusterInfo.caData
    ? { server: clusterInfo.server, 'certificate-authority-data': clusterInfo.caData }
    : { server: clusterInfo.server, 'insecure-skip-tls-verify': true };

  const kpClusterName = `kubepilot-${clusterInfo.clusterName}`;
  const kpContextName = `kubepilot-${context}`;

  return yamlLib.dump({
    apiVersion: 'v1',
    kind: 'Config',
    'current-context': kpContextName,
    clusters: [{ name: kpClusterName, cluster: clusterEntry }],
    users:    [{ name: commonName, user: { 'client-certificate-data': certPemB64, 'client-key-data': keyPemB64 } }],
    contexts: [{ name: kpContextName, context: { cluster: kpClusterName, user: commonName, namespace: 'default' } }],
  });
}

function _resolveContext(clusterName) {
  const entry = getClusters().find(c => c.name === clusterName);
  if (!entry) throw new Error(`Cluster "${clusterName}" is not monitored`);
  return entry.context;
}

// Issue a client certificate for a user
async function issueCertificate(userId, clusterName) {
  const user = await User.findById(userId).lean();
  if (!user) throw new Error('User not found');
  const context = _resolveContext(clusterName);

  await rbacSync.syncUserToK8s(userId);

  const { keyPem, csrPem } = await _generateKeyAndCsr(user.email);
  const csrName   = `kp-${_sanitize(user.email)}-${Date.now()}`;
  const csrPemB64 = Buffer.from(csrPem, 'utf8').toString('base64');

  let certB64;
  try {
    await kubectl.submitCsr(csrName, csrPemB64, context);
    await kubectl.approveCsr(csrName, context);
    certB64 = await _pollForCertificate(csrName, context);
  } catch (err) {
    await kubectl.deleteCsr(csrName, context).catch(() => {});
    throw err;
  }
  kubectl.deleteCsr(csrName, context).catch(() => {});
  const certPem = Buffer.from(certB64, 'base64').toString('utf8');

  await UserCertificate.findOneAndUpdate(
    { userId: String(userId), cluster: clusterName },
    {
      userId: String(userId), cluster: clusterName, commonName: user.email,
      certPem, encryptedKey: notifCrypto.encrypt({ keyPem }),
      csrName, issuedAt: new Date(),
    },
    { upsert: true }
  );

  const clusterInfo = await kubectl.getClusterConnectionInfo(context);
  const kubeconfig = _buildKubeconfig({
    context, clusterInfo, commonName: user.email,
    certPemB64: Buffer.from(certPem, 'utf8').toString('base64'),
    keyPemB64:  Buffer.from(keyPem,  'utf8').toString('base64'),
  });

  return { certPem, kubeconfig };
}

// Get the kubeconfig of an issued certificate
async function getStoredKubeconfig(userId, clusterName) {
  const record = await UserCertificate.findOne({ userId: String(userId), cluster: clusterName }).lean();
  if (!record) throw new Error('No certificate has been issued for this user on this cluster');

  const context = _resolveContext(clusterName);
  const { keyPem } = notifCrypto.decrypt(record.encryptedKey);
  if (!keyPem) throw new Error('Stored private key could not be decrypted');

  const clusterInfo = await kubectl.getClusterConnectionInfo(context);
  return _buildKubeconfig({
    context, clusterInfo, commonName: record.commonName,
    certPemB64: Buffer.from(record.certPem, 'utf8').toString('base64'),
    keyPemB64:  Buffer.from(keyPem,        'utf8').toString('base64'),
  });
}

async function revokeCertificate(userId, clusterName) {
  const res = await UserCertificate.deleteOne({ userId: String(userId), cluster: clusterName });
  return { removed: res.deletedCount > 0 };
}

module.exports = { issueCertificate, getStoredKubeconfig, revokeCertificate };
