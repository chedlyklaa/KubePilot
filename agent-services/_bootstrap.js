'use strict';
// Shared boot for every agent service entrypoint in this folder: load .env, validate the
// config loudly (same as index.js), and — only for the two k8s gateways — open the
// pieces cluster credentials depend on (Mongo ClusterCredential + the runtime dir
// sessionManager materializes per-cluster kubeconfigs into). LLM agents never call
// withClusterCredentials(), which is the point: they hold no cluster access.
require('dotenv').config({ override: true });

const { loadConfig } = require('../src/config');
try {
  loadConfig();
} catch (err) {
  console.error(`❌  ${err.message}`);
  process.exit(1);
}

async function withClusterCredentials() {
  const sessionManager = require('../src/services/sessionManager');
  sessionManager.initRuntimeDir();
  await require('../src/db/connection').connect();
}

// Mongo only (no kubeconfig materialization) — for agents that read their own
// knowledge/metrics collections: reflection (rules, episodes), planner (capacity forecasts).
async function withDatabase() {
  await require('../src/db/connection').connect();
}

module.exports = { withClusterCredentials, withDatabase };
