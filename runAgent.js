require('dotenv').config();
require('./src/api/logStore');

// Keep the process alive — log errors instead of crashing
process.on('uncaughtException',  err => console.error('[PROCESS] Uncaught exception:', err.message));
process.on('unhandledRejection', err => console.error('[PROCESS] Unhandled rejection:', err?.message ?? err));

const { connect }        = require('./src/db/connection');
const { seedUsers }      = require('./src/api/authService');
const { createServer }   = require('./src/api/server');
const escalationStore    = require('./src/api/escalationStore');
const yaml         = require('js-yaml');
const fs           = require('fs');
const path         = require('path');
const ClusterAgent = require('./src/agents/clusterAgent');

const CONFIG_PATH = path.join(__dirname, 'config/clusters.yaml');
const config      = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8'));
const clusters    = config.clusters ?? [];

if (clusters.length === 0) {
  console.error('No clusters defined in config/clusters.yaml');
  process.exit(1);
}

const CYCLE_INTERVAL_MS = parseInt(process.env.CYCLE_INTERVAL_MS || '30000', 10);

// Connect to MongoDB first, then start everything
connect()
  .then(() => seedUsers())
  .then(() => escalationStore.init())
  .then(() => {
    createServer(process.env.API_PORT || 3001);

    console.log(`\nStarting ${clusters.length} agent(s)...`);
    for (const c of clusters) {
      console.log(`  → ${c.name}  context=${c.context}  tier=${c.tier}`);
    }

    const agents = clusters.map(c => new ClusterAgent(c));

    for (const agent of agents) {
      (async () => {
        while (true) {
          try { await agent.run(); }
          catch (err) { console.error(`[${agent.name}] Cycle error: ${err.message}`); }
          await new Promise(r => setTimeout(r, CYCLE_INTERVAL_MS));
        }
      })();
    }
  })
  .catch(err => {
    console.error('[DB] Connection failed:', err.message);
    process.exit(1);
  });
