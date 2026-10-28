'use strict';
const k8s = require('@kubernetes/client-node');
const sessionManager = require('../services/sessionManager');

const _clients = new Map();

async function _loadKubeConfig(context) {
  const credPath = await sessionManager.getKubeconfigPath(context);

  const kc = new k8s.KubeConfig();
  if (credPath) {
    kc.loadFromFile(credPath);
  } else {
    kc.loadFromDefault();
    kc.setCurrentContext(context);
  }

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

// Get the KubeConfig for a context
async function getKubeConfig(context) {
  const { kc } = await _loadKubeConfig(context);
  return kc;
}

module.exports = { getCoreV1Api, getKubeConfig };
