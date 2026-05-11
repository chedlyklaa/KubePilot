require('dotenv').config();
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const cron = require('node-cron');

// ==============================
// Load cluster configuration
// ==============================
const configPath = path.join(__dirname, 'config', 'clusters.yaml');

function loadClusters() {
  try {
    const file = fs.readFileSync(configPath, 'utf8');
    return yaml.load(file);
  } catch (error) {
    console.error('Failed to load cluster config:', error.message);
    process.exit(1);
  }
}

// ==============================
// Fake risk engine (temporary)
// ==============================
function calculateRisk(action) {
  const riskMap = {
    inspect: 0.1,
    restart_pod: 0.2,
    scale_small: 0.3,
    scale_large: 0.6,
    delete_resource: 0.9,
  };

  return riskMap[action] || 0.5;
}

// ==============================
// Simulated cluster agent
// ==============================
async function runClusterAgent(cluster) {
  console.log(`\n[${cluster.name}] Checking cluster status...`);

  // Fake detected issue
  const detectedIssue = {
    type: 'CrashLoopBackOff',
    namespace: 'default',
    pod: 'api-server-7f99f8c9f5-abc12',
    suggestedAction: 'restart_pod',
  };

  console.log(`[${cluster.name}] Detected issue: ${detectedIssue.type}`);

  const risk = calculateRisk(detectedIssue.suggestedAction);

  console.log(`[${cluster.name}] Risk score: ${risk}`);

  // Decision logic
  if (risk < 0.3) {
    console.log(`[${cluster.name}] Autonomous execution approved`);

    // TODO: Replace with real kubectl tool
    console.log(
      `[${cluster.name}] Restarting pod ${detectedIssue.pod}...`
    );
  } else if (risk < 0.7) {
    console.log(`[${cluster.name}] Execute + notify human`);
  } else {
    console.log(`[${cluster.name}] BLOCKED — human approval required`);
  }

  // Audit log
  const logLine = {
    timestamp: new Date().toISOString(),
    cluster: cluster.name,
    issue: detectedIssue.type,
    action: detectedIssue.suggestedAction,
    risk,
  };

  const logPath = path.join(__dirname, 'audit.log');
  fs.appendFileSync(logPath, JSON.stringify(logLine) + '\n');
}

// ==============================
// Fleet orchestrator
// ==============================
async function orchestratorLoop() {
  console.log('\n====================================');
  console.log('AKS Fleet Orchestrator Running');
  console.log('====================================');

  const config = loadClusters();

  for (const cluster of config.clusters) {
    await runClusterAgent(cluster);
  }

  console.log('\nCycle completed');
}

// ==============================
// Start scheduler
// ==============================
console.log('Starting AKS Autonomous Agent...');

// Run immediately
orchestratorLoop();

// Then every 5 minutes
cron.schedule('*/5 * * * *', () => {
  orchestratorLoop();
});
