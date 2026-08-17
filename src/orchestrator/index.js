'use strict';
const ClusterAgent     = require('../agents/clusterAgent');
const vectorStore      = require('../memory/vectorStore');
const episodicMemory   = require('../memory/episodicMemory');
const ruleEngine       = require('../memory/ruleEngine');
const metricsCollector = require('../monitoring/metricsCollector');
const clusterConfig    = require('../config/clusterConfig');
const rbacWatcher      = require('../services/rbacWatcher');
const { loadConfig }   = require('../config');

class FleetOrchestrator {
  constructor() {
    this.clusterAgents  = [];
    this._pendingReload = false;
  }

  initializeAgents() {
    console.log('\nInitializing cluster agents...');
    const clusters = clusterConfig.getClusters();
    this.clusterAgents = clusters.map(cluster => {
      console.log(`  → ${cluster.name} (${cluster.tier ?? 'dev'})`);
      return new ClusterAgent(cluster);
    });
    console.log(`${this.clusterAgents.length} cluster agent(s) ready`);
  }

  // ── Hot-reload: add/remove agents without restarting ─────────────────────
  _reconcileAgents() {
    const newClusters = clusterConfig.getClusters();

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

  // ── React to clusters.yaml changes (shared watcher — see src/config/clusterConfig.js) ──
  // Reconciliation itself is deferred to the next cycle boundary (runFleetCycle), not run
  // immediately here, so agents are never swapped out mid-cycle.
  _startConfigWatcher() {
    clusterConfig.onChange(() => {
      this._pendingReload = true;
      console.log('[ORCHESTRATOR] clusters.yaml changed — will hot-reload after current cycle');
    });
    console.log('[BOOT] Config watcher : active (cluster changes apply without restart)');
  }

  async runFleetCycle() {
    if (this._pendingReload) {
      this._pendingReload = false;
      this._reconcileAgents();
    }

    console.log('\n====================================');
    console.log('FLEET ORCHESTRATOR CYCLE STARTED');
    console.log('====================================');

    const t0 = Date.now();
    const agents = [...this.clusterAgents];
    const concurrency = loadConfig().CLUSTER_CONCURRENCY;

    // Run clusters concurrently with a concurrency cap
    const queue = [...agents];
    const running = new Set();

    await new Promise(resolve => {
      function next() {
        if (queue.length === 0 && running.size === 0) return resolve();
        while (queue.length > 0 && running.size < concurrency) {
          const agent = queue.shift();
          const p = agent.run().catch(err => {
            console.error(`[ORCHESTRATOR] ${agent.name} failed: ${err.message}`);
          }).finally(() => {
            running.delete(p);
            next();
          });
          running.add(p);
        }
      }
      next();
    });

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

    // ── RBAC live watch (feature-flagged, no-op unless RBAC_WATCH_ENABLED) ─
    rbacWatcher.boot();

    // ── First cycle immediately ───────────────────────────────────────────
    await this.runFleetCycle();

    const intervalMs = intervalMsOverride ?? loadConfig().CYCLE_INTERVAL_MS;
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
