'use strict';

const os        = require('os');
const path      = require('path');
const fs        = require('fs');
const { execFile } = require('child_process');
const yamlLib   = require('js-yaml');
const kubectl   = require('../tools/kubectl');
const rbacSync  = require('./rbacSync');
const notifCrypto = require('./notifications/crypto'); // generic AES-256-GCM encrypt/decrypt, reused here
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

// Generates a fresh RSA keypair + PKCS#10 CSR for the given CN, entirely in a
// per-call temp directory that's removed immediately after reading the results —
// the private key never touches disk longer than the few ms this takes.
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

// K8s issues the signed cert asynchronously after approval — poll briefly rather
// than assuming it's instantly ready.
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

  // Prefixed rather than reusing the source cluster's own context/cluster name —
  // if a user merges this file into their own existing ~/.kube/config (which may
  // already have an entry with that exact name), reusing the name would silently
  // overwrite one or the other depending on merge order.
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

// Issues a fresh client certificate for a user on one cluster:
//   1. syncs their current system permissions into K8s RoleBindings (subject
//      kind:User name:email) — the same bindings that already authorize
//      `kubectl --as=email` impersonation now also authorize this cert, since
//      its CN is the user's email too
//   2. generates a keypair + CSR, gets it signed via the K8s CSR API
//   3. stores the cert + encrypted private key (replaces any previous one for
//      this user+cluster)
// Returns the kubeconfig text for immediate download — the plaintext private key
// is never returned again after this call; re-download later goes through
// getStoredKubeconfig(), which decrypts the stored copy.
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
    // Don't leave an unsigned/orphaned CSR object behind on failure — otherwise every
    // failed attempt (e.g. the agent lacking `approve` permission on the signer)
    // accumulates a stuck CSR until Kubernetes' own expiry cleans it up.
    await kubectl.deleteCsr(csrName, context).catch(() => {});
    throw err;
  }
  kubectl.deleteCsr(csrName, context).catch(() => {}); // best-effort cleanup, already have what we need
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

// Rebuilds the kubeconfig for a previously issued certificate, using the CURRENT
// cluster server/CA info (so it stays correct even if the cluster endpoint changed
// since issuance) and the stored, decrypted private key.
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
