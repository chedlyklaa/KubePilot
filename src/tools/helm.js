// src/tools/helm.js
'use strict';

const { execFile } = require('child_process');

function runHelm(args, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'helm', args,
      { maxBuffer: 10 * 1024 * 1024, timeout: timeoutMs },
      (error, stdout, stderr) => {
        if (error) {
          const msg = stderr?.trim() || error.message || 'Unknown helm error';
          return reject(new Error(msg));
        }
        resolve(stdout.trim());
      }
    );
    child.on('error', reject);
  });
}

// Cheap probe — helm may simply not be installed on the KubePilot host, which should
// degrade to "unavailable" in the UI, not a hard error.
async function isHelmAvailable() {
  try {
    await runHelm(['version', '--short'], { timeoutMs: 5_000 });
    return true;
  } catch {
    return false;
  }
}

async function listReleases(context) {
  const out = await runHelm(['list', '--all-namespaces', '--kube-context', context, '-o', 'json']);
  return JSON.parse(out || '[]');
}

async function getReleaseStatus(release, namespace, context) {
  const out = await runHelm(['status', release, '-n', namespace, '--kube-context', context, '-o', 'json']);
  return JSON.parse(out);
}

async function rollbackRelease(release, namespace, context) {
  return runHelm(['rollback', release, '-n', namespace, '--kube-context', context]);
}

module.exports = { isHelmAvailable, listReleases, getReleaseStatus, rollbackRelease };
