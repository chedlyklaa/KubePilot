// src/tools/k8sClient.js
//
// Long-lived Kubernetes API clients, one per context, reused across calls —
// unlike kubectl.js's runCommand() which spawns a brand-new `kubectl` process
// (fresh kubeconfig parse + fresh TLS handshake) on every single call. Built
// incrementally: only the read paths that have been migrated ask for a client
// here, everything else still goes through kubectl.js's execFile path.

'use strict';
const k8s = require('@kubernetes/client-node');
const sessionManager = require('../services/sessionManager');

// context → { key, api } — `key` is the resolved kubeconfig path (or a
// `shared:<context>` marker for contexts with no stored credential). Keying
// the cache on that path means a credential rotation — which makes
// sessionManager hand back a new path — naturally busts this cache too,
// without k8sClient needing to know anything about rotation itself.
const _clients = new Map();

async function _loadKubeConfig(context) {
  const credPath = await sessionManager.getKubeconfigPath(context);

  const kc = new k8s.KubeConfig();
  if (credPath) {
    kc.loadFromFile(credPath); // credential-backed cluster's own single-context file
  } else {
    kc.loadFromDefault(); // server's shared kubeconfig — same fallback runCommand() uses
    kc.setCurrentContext(context);
  }

  // Cache key includes the resolved API server URL, not just the context name — a
  // shared kubeconfig's server address can change without the context name changing
  // (e.g. minikube reassigning its local tunnel port on every restart), and keying on
  // just the context silently kept serving a client pointed at a dead connection.
  // Credential rotation already changes credPath itself, so that alone is enough there.
  const server = kc.getCurrentCluster()?.server ?? '';
  const key = credPath ? credPath : `shared:${context}:${server}`;
  return { kc, key };
}

async function getCoreV1Api(context) {
  const { kc, key } = await _loadKubeConfig(context);
  const cached = _clients.get(context);
  if (cached && cached.key === key) return cached.api;

  const api = kc.makeApiClient(k8s.CoreV1Api);
  _clients.set(context, { key, api });
  return api;
}

// Raw KubeConfig for callers that need something other than a REST API client —
// e.g. rbacWatcher.js, which hands it to @kubernetes/client-node's Watch class.
// Not cached: Watch only needs it once per connection attempt, and caching would
// mean re-implementing the same credential-rotation bust logic as getCoreV1Api
// for a value that's cheap to rebuild.
async function getKubeConfig(context) {
  const { kc } = await _loadKubeConfig(context);
  return kc;
}

module.exports = { getCoreV1Api, getKubeConfig };
