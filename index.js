// override: true — otherwise a variable already sitting in the shell's environment
// (e.g. a leftover `$env:OPENAI_API_KEY = "..."` from an earlier debugging session)
// silently wins over .env. This is the FIRST env load in the process and loadConfig()
// below caches its result for the process's entire lifetime, so getting this right
// here is what actually matters — a later override:true elsewhere (e.g. llmClient.js)
// is too late, since by then loadConfig() has already frozen the (possibly stale) config.
require('dotenv').config({ override: true });
require('./src/api/logStore');

// ─── Validate environment up front — fails loudly here instead of at request time ───
const { loadConfig } = require('./src/config');
let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(`❌  ${err.message}`);
  process.exit(1);
}

const { connect }        = require('./src/db/connection');
const { seedUsers }      = require('./src/api/authService');
const { createServer }   = require('./src/api/server');
const escalationStore    = require('./src/api/escalationStore');
const silenceStore       = require('./src/api/silenceStore');
const sessionManager     = require('./src/services/sessionManager');

// Sweep any per-cluster kubeconfig files orphaned by a previous crash before anything
// starts using the runtime directory — this is the real cleanup guarantee, not the
// shutdown handlers (which never fire on SIGKILL or a hard crash).
sessionManager.initRuntimeDir();

// ─── Auto port-forward: Prometheus ──────────────────────────────────────────
// Spawns kubectl port-forward in the background so PROMETHEUS_URL=http://localhost:9090
// works without manual setup. Restarts automatically if the process dies.
// Only runs when PROMETHEUS_URL points to localhost (skip for remote clusters).
;(function startPrometheusForward() {
  const url = config.PROMETHEUS_URL;
  if (!url.includes('localhost') && !url.includes('127.0.0.1')) return;

  const { spawn } = require('child_process');
  const net   = require('net');
  const SVC   = 'svc/kube-prometheus-stack-prometheus';
  const NS    = config.PROMETHEUS_NAMESPACE;
  const LOCAL = new URL(url).port || '9090';
  let   stopping = false;

  process.on('SIGINT',  () => { stopping = true; });
  process.on('SIGTERM', () => { stopping = true; });

  function spawnForward() {
    const pf = spawn('kubectl', [
      'port-forward', SVC, '-n', NS, `${LOCAL}:9090`, '--address=127.0.0.1',
    ], { stdio: 'pipe' });

    pf.on('spawn', () => console.log(`[PROM] Port-forward started → localhost:${LOCAL}`));
    pf.on('error', () => {});
    pf.stderr?.on('data', d => {
      // suppress "address already in use" noise — probe handles that case
      const msg = d.toString().trim();
      if (msg && !msg.includes('address already in use')) console.warn(`[PROM] ${msg}`);
    });
    pf.on('close', () => {
      if (!stopping) setTimeout(start, 5_000);
    });
    process._prometheusForward = pf;
  }

  function start() {
    if (stopping) return;
    // Probe: if port already bound (previous forward still alive) skip spawn
    const probe = net.createConnection({ port: Number(LOCAL), host: '127.0.0.1' });
    probe.setTimeout(800);
    probe.on('connect', () => {
      probe.destroy();
      console.log(`[PROM] localhost:${LOCAL} already reachable — skipping port-forward`);
    });
    probe.on('error',   () => { probe.destroy(); spawnForward(); });
    probe.on('timeout', () => { probe.destroy(); spawnForward(); });
  }

  start();
}());

connect()
  .then(() => seedUsers())
  .then(() => escalationStore.init())
  .then(() => silenceStore.init())
  .then(() => createServer(config.API_PORT))
  .catch(err => { console.error('[DB] Connection failed:', err.message); process.exit(1); });

const Orchestrator  = require('./src/orchestrator/index.js');
const ClusterAgent  = require('./src/agents/clusterAgent');
const clusterConfig = require('./src/config/clusterConfig');

// ─── Parse CLI args ─────────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const mode    = args.includes('--benchmark') ? 'benchmark'
              : args.includes('--task')      ? 'task'
              : 'autonomous';

async function main() {
  if (mode === 'autonomous') {
    // Start the full fleet autonomous loop
    const orchestrator = new Orchestrator();
    await orchestrator.start(config.CYCLE_INTERVAL_MS);

  } else if (mode === 'task') {
    // Run a single task against a specific cluster
    const taskIdx   = args.indexOf('--task');
    const task      = args[taskIdx + 1];
    const clusterIdx = args.indexOf('--cluster');
    const clusterName = clusterIdx >= 0 ? args[clusterIdx + 1] : null;

    const clusters = clusterConfig.getClusters();
    const clusterConfigEntry = clusterName
      ? clusters.find(c => c.name === clusterName)
      : clusters[0];

    if (!clusterConfigEntry) {
      console.error(` Cluster not found: ${clusterName}`);
      process.exit(1);
    }

    console.log(`Running task on ${clusterConfigEntry.name}: "${task}"\n`);
    const agent = new ClusterAgent(clusterConfigEntry);
    const result = await agent.run(task);
    console.log('\nTask complete:', JSON.stringify(result, null, 2));

  } else if (mode === 'benchmark') {
    // Run the evaluation benchmark
    const { runBenchmark } = require('./benchmark/runner/run');
    await runBenchmark();
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
