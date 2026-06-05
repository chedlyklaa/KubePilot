'use strict';
const fs   = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ClusterAgent     = require('../agents/clusterAgent');
const vectorStore      = require('../memory/vectorStore');
const episodicMemory   = require('../memory/episodicMemory');
const ruleEngine       = require('../memory/ruleEngine');
const metricsCollector = require('../monitoring/metricsCollector');

class FleetOrchestrator {
  constructor() {
    this.clusterAgents   = [];
    this.configPath      = path.join(__dirname, '../../config/clusters.yaml');
    this._pendingReload  = false;
    this._reloadDebounce = null;
  }

  loadClusterConfig() {
    try {
      const file   = fs.readFileSync(this.configPath, 'utf8');
      const config = yaml.load(file);
      return config.clusters || [];
    } catch (err) {
      console.error('Failed to load cluster configuration:', err.message);
      process.exit(1);
    }
  }

  initializeAgents() {
    console.log('\nInitializing cluster agents...');
    const clusters = this.loadClusterConfig();
    this.clusterAgents = clusters.map(cluster => {
      console.log(`  → ${cluster.name} (${cluster.tier ?? 'dev'})`);
      return new ClusterAgent(cluster);
    });
    console.log(`${this.clusterAgents.length} cluster agent(s) ready`);
  }

  // ── Hot-reload: add/remove agents without restarting ─────────────────────
  _reconcileAgents() {
    let newClusters;
    try {
      const file = fs.readFileSync(this.configPath, 'utf8');
      newClusters = yaml.load(file)?.clusters ?? [];
    } catch (err) {
      console.error('[ORCHESTRATOR] Hot-reload: could not parse clusters.yaml —', err.message);
      return;
    }

    const existingByCtx = new Map(this.clusterAgents.map(a => [a.context, a]));
    const desiredCtxs   = new Set(newClusters.map(c => c.context));

    let added = 0, removed = 0;

    // Add newly configured clusters
    for (const cluster of newClusters) {
      if (!existingByCtx.has(cluster.context)) {
        this.clusterAgents.push(new ClusterAgent(cluster));
        console.log(`[ORCHESTRATOR] Hot-reload: + added   "${cluster.name}" (${cluster.context})`);
        added++;
      }
    }

    // Remove de-configured clusters
    const before = this.clusterAgents.length;
    this.clusterAgents = this.clusterAgents.filter(a => desiredCtxs.has(a.context));
    removed = before + added - this.clusterAgents.length;
    if (removed > 0) console.log(`[ORCHESTRATOR] Hot-reload: - removed  ${removed} agent(s)`);

    console.log(`[ORCHESTRATOR] Hot-reload complete — ${this.clusterAgents.length} agent(s) active`);
  }

  // ── Watch clusters.yaml for changes ──────────────────────────────────────
  _startConfigWatcher() {
    try {
      fs.watch(this.configPath, eventType => {
        if (eventType !== 'change') return;
        // Debounce: yaml.dump writes the file in two steps on some OSes
        clearTimeout(this._reloadDebounce);
        this._reloadDebounce = setTimeout(() => {
          this._pendingReload = true;
          console.log('[ORCHESTRATOR] clusters.yaml changed — will hot-reload after current cycle');
        }, 500);
      });
      console.log('[BOOT] Config watcher : active (cluster changes apply without restart)');
    } catch (err) {
      console.warn('[BOOT] Config watcher : could not start —', err.message);
    }
  }

  async runFleetCycle() {
    // Apply any pending config reload before starting the cycle
    if (this._pendingReload) {
      this._pendingReload = false;
      this._reconcileAgents();
    }

    console.log('\n====================================');
    console.log('FLEET ORCHESTRATOR CYCLE STARTED');
    console.log('====================================');

    const t0 = Date.now();

    // Snapshot the agent list so mid-cycle reconciliation can't corrupt iteration
    const agents = [...this.clusterAgents];
    for (const agent of agents) {
      await agent.run();
    }

    const duration = ((Date.now() - t0) / 1000).toFixed(2);
    console.log('\n====================================');
    console.log('FLEET CYCLE COMPLETED');
    console.log(`Duration: ${duration}s`);
    console.log('====================================');
  }

  async start(intervalMsOverride) {
    console.log('\n====================================');
    console.log('STARTING KUBEPILOT FLEET ORCHESTRATOR');
    console.log('====================================');

    // ── Initialize memory systems before first cycle ──────────────────────
    console.log('\n[BOOT] Initializing memory systems...');

    await vectorStore.initialize();
    await episodicMemory.initialize();
    await metricsCollector.initialize();

    const ruleStats = await ruleEngine.stats();
    const memStats  = episodicMemory.stats();
    console.log(`[BOOT] VectorStore  : ${vectorStore.ready ? 'ready' : 'offline (semantic search disabled)'}`);
    console.log(`[BOOT] EpisodicMem  : ${memStats.episodes} episodes in ${memStats.buckets} buckets`);
    console.log(`[BOOT] LearnedRules : ${ruleStats.active} active / ${ruleStats.total} total`);
    console.log(`[BOOT] Prometheus   : ${metricsCollector.isAvailable() ? 'connected — metrics enabled' : 'unavailable — metrics disabled (continuing without)'}`);

    // ── Initialize agents ─────────────────────────────────────────────────
    this.initializeAgents();

    // ── Watch for config changes (hot-reload) ─────────────────────────────
    this._startConfigWatcher();

    // ── First cycle immediately ───────────────────────────────────────────
    await this.runFleetCycle();

    const intervalMs = intervalMsOverride ?? parseInt(process.env.CYCLE_INTERVAL_MS || '300000', 10);
    console.log(`\nNext cycle in ${intervalMs / 1000}s`);

    const loop = async () => {
      try {
        await this.runFleetCycle();
      } catch (err) {
        console.error('[ORCHESTRATOR] Fleet cycle failed:', err.message);
      }
      setTimeout(loop, intervalMs);
    };
    setTimeout(loop, intervalMs);
  }
}

module.exports = FleetOrchestrator;
