'use strict';

const axios = require('axios');

// ── Phase 6: Predefined PromQL query templates ────────────────────────────────
const QUERIES = {
  // CPU usage rate (cores) for a pod across all containers
  cpuUsage: (ns, pod) =>
    `rate(container_cpu_usage_seconds_total{namespace="${ns}",pod="${pod}",container!=""}[5m])`,

  // Memory working set in bytes (excludes page-cache, closest to actual usage)
  memoryUsage: (ns, pod) =>
    `container_memory_working_set_bytes{namespace="${ns}",pod="${pod}",container!=""}`,

  // Total restart count across all containers in the pod
  restartCount: (ns, pod) =>
    `sum(kube_pod_container_status_restarts_total{namespace="${ns}",pod="${pod}"})`,

  // OOMKilled detection — returns 1 if any container last terminated with OOMKilled
  oomKilledCheck: (ns, pod) =>
    `kube_pod_container_status_last_terminated_reason{namespace="${ns}",pod="${pod}",reason="OOMKilled"}`,

  // Node pressure conditions (MemoryPressure, DiskPressure, PIDPressure)
  nodePressure: (node) =>
    `kube_node_status_condition{node="${node}",condition=~"MemoryPressure|DiskPressure|PIDPressure",status="true"}`,

  // Node CPU usage (all modes except idle)
  nodeCpu: (node) =>
    `sum(rate(node_cpu_seconds_total{instance=~"${node}.*",mode!="idle"}[5m]))`,

  // Node memory consumption (total - available)
  nodeMemory: (node) =>
    `node_memory_MemTotal_bytes{instance=~"${node}.*"} - node_memory_MemAvailable_bytes{instance=~"${node}.*"}`,
};

// ── PrometheusClient ──────────────────────────────────────────────────────────

// How long to wait before retrying a failed Prometheus connection (ms)
const RECONNECT_COOLDOWN_MS = 30_000;

class PrometheusClient {
  /**
   * @param {string} [baseUrl]  Prometheus base URL (default: PROMETHEUS_URL env or localhost:9090)
   */
  constructor(baseUrl = process.env.PROMETHEUS_URL || 'http://localhost:9090') {
    this.baseUrl      = baseUrl.replace(/\/$/, '');
    this.available    = false;
    this._lastFailAt  = 0;       // timestamp of last failed probe
    this._probing     = false;   // prevent concurrent re-probes
  }

  // ── Connectivity probe ──────────────────────────────────────────────────────
  async initialize() {
    try {
      await axios.get(`${this.baseUrl}/-/healthy`, { timeout: 3000 });
      this.available   = true;
      this._lastFailAt = 0;
      console.log(`[PrometheusClient] Connected at ${this.baseUrl}`);
    } catch {
      this.available   = false;
      this._lastFailAt = Date.now();
      console.warn(`[PrometheusClient] Unreachable at ${this.baseUrl} — will retry automatically`);
    }
    return this.available;
  }

  // Re-probe in the background if the cooldown has elapsed. Non-blocking.
  _maybeReconnect() {
    if (this.available || this._probing) return;
    if (Date.now() - this._lastFailAt < RECONNECT_COOLDOWN_MS) return;
    this._probing = true;
    this.initialize().finally(() => { this._probing = false; });
  }

  // ── Instant query  GET /api/v1/query ────────────────────────────────────────
  async query(promql) {
    this._maybeReconnect();
    if (!this.available) return null;
    try {
      const res = await axios.get(`${this.baseUrl}/api/v1/query?query=up`, {
        params:  { query: promql },
        timeout: 5000,
      });
      if (res.data?.status === 'success') return res.data.data.result;
      return null;
    } catch {
      this.available   = false;
      this._lastFailAt = Date.now();
      return null;
    }
  }

  // ── Range query   GET /api/v1/query_range ───────────────────────────────────
  async queryRange(promql, start, end, step = '60s') {
    this._maybeReconnect();
    if (!this.available) return null;
    try {
      const res = await axios.get(`${this.baseUrl}/api/v1/query_range`, {
        params:  { query: promql, start, end, step },
        timeout: 8000,
      });
      return res.data?.status === 'success' ? res.data.data.result : null;
    } catch {
      return null;
    }
  }

  // ── Pod metrics bundle (last 15 min) ────────────────────────────────────────
  async getPodMetrics(namespace, podName) {
    const now    = Math.floor(Date.now() / 1000);
    const ago15m = now - 900;

    const [cpuRange, memRange, restarts, oomCheck] = await Promise.all([
      this.queryRange(QUERIES.cpuUsage(namespace, podName),    ago15m, now, '60s'),
      this.queryRange(QUERIES.memoryUsage(namespace, podName), ago15m, now, '60s'),
      this.query(QUERIES.restartCount(namespace, podName)),
      this.query(QUERIES.oomKilledCheck(namespace, podName)),
    ]);

    return { cpuRange, memRange, restarts, oomCheck, namespace, podName };
  }

  // ── Node metrics bundle (last 15 min) ───────────────────────────────────────
  async getNodeMetrics(nodeName) {
    const now    = Math.floor(Date.now() / 1000);
    const ago15m = now - 900;

    const [cpuRange, memRange, pressure] = await Promise.all([
      this.queryRange(QUERIES.nodeCpu(nodeName),    ago15m, now, '60s'),
      this.queryRange(QUERIES.nodeMemory(nodeName), ago15m, now, '60s'),
      this.query(QUERIES.nodePressure(nodeName)),
    ]);

    return { cpuRange, memRange, pressure, nodeName };
  }
}

module.exports = { PrometheusClient, QUERIES };
