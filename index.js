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
const issueTrackerStore  = require('./src/api/issueTrackerStore');
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

  const { spawn, execFile } = require('child_process');
  const net   = require('net');
  const SVC   = 'svc/kube-prometheus-stack-prometheus';
  const NS    = config.PROMETHEUS_NAMESPACE;
  const LOCAL = new URL(url).port || '9090';
  let   stopping = false;
  // Only ever attempted ONCE per process — a slow/failed Helm install must not repeat
  // on every 5s port-forward retry below (which otherwise runs forever independent of
  // this).
  let   installAttempted = false;
  let   installInProgress = false;

  process.on('SIGINT',  () => { stopping = true; });
  process.on('SIGTERM', () => { stopping = true; });

  function execFileP(cmd, args, opts = {}) {
    return new Promise((resolve, reject) => {
      execFile(cmd, args, { maxBuffer: 10 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr?.trim() || err.message));
        resolve(stdout);
      });
    });
  }

  async function namespaceExists() {
    try { await execFileP('kubectl', ['get', 'namespace', NS]); return true; }
    catch { return false; }
  }

  // Installs the same kube-prometheus-stack release scripts/start.sh already sets up
  // manually (same chart, same values) — so running `node index.js` directly, without
  // start.sh, still ends up with a working Prometheus instead of the "namespace not
  // found" port-forward retry looping forever. Best-effort, fire-and-forget (a 3-8
  // minute Helm install must not block the HTTP server from starting or the port-forward
  // retry loop below, which keeps running — and will simply start succeeding once this
  // finishes).
  async function installPrometheusStack() {
    installInProgress = true;
    console.log(`[PROM] namespace "${NS}" not found — installing kube-prometheus-stack into it (this can take several minutes)...`);
    try {
      await execFileP('helm', ['version', '--short']);
    } catch {
      console.warn('[PROM] helm not found on PATH — cannot auto-install. Install manually (see scripts/start.sh) or point PROMETHEUS_URL at an existing instance.');
      installInProgress = false;
      return;
    }
    try {
      await execFileP('helm', ['repo', 'add', 'prometheus-community', 'https://prometheus-community.github.io/helm-charts']).catch(() => {});
      await execFileP('helm', ['repo', 'update']);
      await execFileP('helm', [
        'upgrade', '--install', 'kube-prometheus-stack', 'prometheus-community/kube-prometheus-stack',
        '--namespace', NS, '--create-namespace',
        '--set', 'prometheus.service.type=NodePort',
        '--set', 'prometheus.prometheusSpec.scrapeInterval=30s',
        '--set', 'grafana.adminPassword=kubepilot',
        '--set', 'grafana.service.type=NodePort',
        '--set', 'grafana.defaultDashboardsEnabled=true',
        '--set', 'defaultRules.create=true',
        '--set', 'alertmanager.enabled=false',
        '--set', 'kubeControllerManager.enabled=false',
        '--set', 'kubeScheduler.enabled=false',
        '--timeout', '10m', '--wait',
      ], { timeout: 11 * 60 * 1000 });
      console.log(`[PROM] kube-prometheus-stack installed in namespace "${NS}" — port-forward should connect on the next retry`);
    } catch (err) {
      console.warn(`[PROM] auto-install failed: ${err.message} — install manually (see scripts/start.sh) or point PROMETHEUS_URL at an existing instance`);
    } finally {
      installInProgress = false;
    }
  }

  function spawnForward() {
    const pf = spawn('kubectl', [
      'port-forward', SVC, '-n', NS, `${LOCAL}:9090`, '--address=127.0.0.1',
    ], { stdio: 'pipe' });

    pf.on('spawn', () => console.log(`[PROM] Port-forward started → localhost:${LOCAL}`));
    pf.on('error', () => {});
    pf.stderr?.on('data', d => {
      // Suppress noise for two known, already-handled cases: "address already in use"
      // (the probe handles that) and anything while an install is in flight (we already
      // logged why once in installPrometheusStack() — no need to repeat the same
      // NotFound error every 5s until it finishes).
      if (installInProgress) return;
      const msg = d.toString().trim();
      if (msg && !msg.includes('address already in use')) console.warn(`[PROM] ${msg}`);
    });
    pf.on('close', () => {
      if (!stopping) setTimeout(start, 5_000);
    });
    process._prometheusForward = pf;
  }

  async function start() {
    if (stopping) return;

    if (!installAttempted) {
      installAttempted = true; // never retry the install itself, only ever once
      if (!(await namespaceExists())) {
        installPrometheusStack(); // fire-and-forget — see doc comment above
      }
    }

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
  .then(() => issueTrackerStore.init())
  .then(() => createServer(config.API_PORT))
  .catch(err => { console.error('[DB] Connection failed:', err.message); process.exit(1); });

const OrchestratorAgent = require('./src/agents/orchestratorAgent');
const ClusterAgent      = require('./src/agents/clusterAgent');
const clusterConfig     = require('./src/config/clusterConfig');

// ─── Parse CLI args ─────────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const mode    = args.includes('--benchmark') ? 'benchmark'
              : args.includes('--task')      ? 'task'
              : 'autonomous';

async function main() {
  if (mode === 'autonomous') {
    // Always the v5 pipeline (LLM classification + LangGraph remediation, Redis Short
    // Memory) — no longer a runtime toggle (was ORCHESTRATOR_V5_ENABLED). The legacy
    // FleetOrchestrator/ClusterAgent pipeline is no longer reachable from here; the
    // files still exist (ClusterAgent is still used directly by `--task` mode below).
    await OrchestratorAgent.start(config.CYCLE_INTERVAL_MS);

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
