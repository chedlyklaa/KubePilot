'use strict';

const { PrometheusClient } = require('./prometheusClient');

const CACHE_TTL_MS = 60_000; // 60 s — one fresh fetch per pod per minute

// ── MetricsCollector ──────────────────────────────────────────────────────────
// Aggregates raw Prometheus time-series into structured summaries used by
// PlannerAgent and stored in incident episodes.

class MetricsCollector {
  constructor() {
    this.client = new PrometheusClient();
    // key → { data, expiresAt }
    this._cache = new Map();
  }

  async initialize() {
    const ok = await this.client.initialize();
    return ok;
  }

  isAvailable() {
    return this.client.available;
  }

  // ── Collect pod metrics ──────────────────────────────────────────────────────
  // Returns a structured summary or null when Prometheus is unavailable.
  async collectPodMetrics(namespace, podName) {
    const cacheKey = `pod:${namespace}:${podName}`;
    const cached   = this._cache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) return cached.data;

    if (!this.client.available) return null;

    try {
      const raw     = await this.client.getPodMetrics(namespace, podName);
      const summary = this._aggregatePod(raw);
      this._cache.set(cacheKey, { data: summary, expiresAt: Date.now() + CACHE_TTL_MS });
      return summary;
    } catch {
      return null;
    }
  }

  // ── Collect all pods in one batch (3 queries instead of 4×N) ────────────────
  // Returns a map of "namespace/pod" → { cpuCores, memBytes, restarts }
  // Used by the dashboard API to populate the Cluster Health table without
  // hitting Prometheus once per pod.
  async collectAllPodsMetrics() {
    const cacheKey = 'batch:all-pods';
    const cached   = this._cache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) return cached.data;

    if (!this.client.available) return null;

    try {
      const [cpuRes, memRes, restartRes] = await Promise.all([
        this.client.query(
          'sum by (namespace, pod) (rate(container_cpu_usage_seconds_total{container!=""}[5m]))'
        ),
        this.client.query(
          'sum by (namespace, pod) (container_memory_working_set_bytes{container!=""})'
        ),
        this.client.query(
          'sum by (namespace, pod) (kube_pod_container_status_restarts_total)'
        ),
      ]);

      const map = {};

      for (const r of (cpuRes ?? [])) {
        const key = `${r.metric.namespace}/${r.metric.pod}`;
        if (!map[key]) map[key] = {};
        map[key].cpuCores = parseFloat(r.value[1]);
      }
      for (const r of (memRes ?? [])) {
        const key = `${r.metric.namespace}/${r.metric.pod}`;
        if (!map[key]) map[key] = {};
        map[key].memBytes = parseFloat(r.value[1]);
      }
      for (const r of (restartRes ?? [])) {
        const key = `${r.metric.namespace}/${r.metric.pod}`;
        if (!map[key]) map[key] = {};
        map[key].restarts = Math.round(parseFloat(r.value[1]));
      }

      this._cache.set(cacheKey, { data: map, expiresAt: Date.now() + CACHE_TTL_MS });
      return map;
    } catch {
      return null;
    }
  }

  // ── Fetch enriched Prometheus alert events ───────────────────────────────────
  // Returns OOMKilled, HighRestarts (with memory context), CPUThrottling,
  // MemNearLimit, ImagePullFailed, and NodePressure alerts.
  async getErrors() {
    const cacheKey = 'batch:errors';
    const cached   = this._cache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) return cached.data;

    if (!this.client.available) return [];

    try {
      const [
        oomRes, highRestartRes, memBytesRes, memLimitRes,
        cpuThrottleRes, imagePullRes, lastTermRes, nodePressureRes,
        exitCodeRes, restartRateRes, cpuMillicoresRes,
      ] = await Promise.all([
        this.client.query(
          'kube_pod_container_status_last_terminated_reason{reason="OOMKilled"}'
        ),
        this.client.query(
          'sum by (namespace, pod) (kube_pod_container_status_restarts_total) > 3'
        ),
        this.client.query(
          'sum by (namespace, pod) (container_memory_working_set_bytes{container!=""})'
        ),
        this.client.query(
          'sum by (namespace, pod) (container_spec_memory_limit_bytes{container!="",container_spec_memory_limit_bytes>0})'
        ),
        this.client.query(
          'sum by (namespace, pod, container) (rate(container_cpu_cfs_throttled_seconds_total{container!=""}[5m])) / ' +
          'sum by (namespace, pod, container) (rate(container_cpu_cfs_periods_total{container!=""}[5m]))'
        ),
        this.client.query(
          'kube_pod_container_status_waiting_reason{reason=~"ImagePullBackOff|ErrImagePull"}'
        ),
        this.client.query(
          'kube_pod_container_status_last_terminated_reason{reason!="Completed"}'
        ),
        this.client.query(
          'kube_node_status_condition{condition=~"MemoryPressure|DiskPressure|PIDPressure",status="true"}'
        ),
        // last exit code per container
        this.client.query(
          'kube_pod_container_status_last_terminated_exit_code'
        ),
        // restarts in the last hour (per pod)
        this.client.query(
          'sum by (namespace, pod) (increase(kube_pod_container_status_restarts_total[1h]))'
        ),
        // current CPU usage in millicores (per pod)
        this.client.query(
          'sum by (namespace, pod) (rate(container_cpu_usage_seconds_total{container!=""}[5m])) * 1000'
        ),
      ]);

      // ── Enrichment lookup maps ─────────────────────────────────────────────
      const memBytesMap = {};
      for (const r of (memBytesRes ?? [])) {
        memBytesMap[`${r.metric.namespace}/${r.metric.pod}`] = parseFloat(r.value[1]);
      }
      const memLimitMap = {};
      for (const r of (memLimitRes ?? [])) {
        memLimitMap[`${r.metric.namespace}/${r.metric.pod}`] = parseFloat(r.value[1]);
      }
      // lastTermMap: stores { reason, container } — the container name tells us which failed
      const lastTermMap = {};
      for (const r of (lastTermRes ?? [])) {
        const key = `${r.metric.namespace}/${r.metric.pod}`;
        if (!lastTermMap[key]) lastTermMap[key] = { reason: r.metric.reason, container: r.metric.container ?? null };
      }
      // exitCodeMap: last exit code + container name
      const exitCodeMap = {};
      for (const r of (exitCodeRes ?? [])) {
        const key = `${r.metric.namespace}/${r.metric.pod}`;
        if (!exitCodeMap[key]) exitCodeMap[key] = {
          code:      Math.round(parseFloat(r.value[1])),
          container: r.metric.container ?? null,
        };
      }
      // restartRateMap: restarts in last hour
      const restartRateMap = {};
      for (const r of (restartRateRes ?? [])) {
        const val = Math.round(parseFloat(r.value[1]));
        if (val > 0) restartRateMap[`${r.metric.namespace}/${r.metric.pod}`] = val;
      }
      // cpuMillicoresMap: current CPU usage
      const cpuMillicoresMap = {};
      for (const r of (cpuMillicoresRes ?? [])) {
        cpuMillicoresMap[`${r.metric.namespace}/${r.metric.pod}`] = Math.round(parseFloat(r.value[1]));
      }

      const errors = [];
      const seen   = new Set();

      // ── OOMKilled ──────────────────────────────────────────────────────────
      for (const r of (oomRes ?? [])) {
        const key = `oom:${r.metric.namespace}/${r.metric.pod}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const podKey        = `${r.metric.namespace}/${r.metric.pod}`;
        const memUsedBytes  = memBytesMap[podKey] ?? null;
        const memLimitBytes = memLimitMap[podKey] ?? null;
        const memUsedMi     = memUsedBytes  ? +(memUsedBytes  / (1024 * 1024)).toFixed(0) : null;
        const memLimitMi    = memLimitBytes ? +(memLimitBytes / (1024 * 1024)).toFixed(0) : null;
        const memPct        = (memUsedBytes && memLimitBytes)
          ? +(memUsedBytes / memLimitBytes * 100).toFixed(0) : null;
        const exitInfo      = exitCodeMap[podKey] ?? null;
        const restartRate   = restartRateMap[podKey] ?? null;
        errors.push({
          type: 'OOMKilled', severity: 'critical',
          namespace: r.metric.namespace, pod: r.metric.pod,
          container:      r.metric.container ?? exitInfo?.container ?? null,
          count:          parseFloat(r.value[1]),
          exitCode:       137,
          restartRate,
          memUsedMi, memLimitMi, memPct,
          lastTermReason: 'OOMKilled',
          suggestion:     'increase_memory',
        });
      }

      // ── HighRestarts ───────────────────────────────────────────────────────
      for (const r of (highRestartRes ?? [])) {
        const count         = Math.round(parseFloat(r.value[1]));
        const podKey        = `${r.metric.namespace}/${r.metric.pod}`;
        const memUsedBytes  = memBytesMap[podKey] ?? null;
        const memLimitBytes = memLimitMap[podKey] ?? null;
        const memUsedMi     = memUsedBytes  ? +(memUsedBytes  / (1024 * 1024)).toFixed(0) : null;
        const memLimitMi    = memLimitBytes ? +(memLimitBytes / (1024 * 1024)).toFixed(0) : null;
        const memPct        = (memUsedBytes && memLimitBytes)
          ? +(memUsedBytes / memLimitBytes * 100).toFixed(0) : null;
        const termInfo      = lastTermMap[podKey] ?? null;
        const termReason    = termInfo?.reason    ?? null;
        const termContainer = termInfo?.container ?? null;
        const exitInfo      = exitCodeMap[podKey] ?? null;
        const exitCode      = exitInfo?.code      ?? null;
        const restartRate   = restartRateMap[podKey]    ?? null;
        const cpuMillicores = cpuMillicoresMap[podKey]  ?? null;

        const CONFIG_REASONS = new Set(['ContainerCannotRun', 'CreateContainerConfigError', 'RunContainerError']);
        const suggestion =
          termReason === 'OOMKilled' || exitCode === 137 || (memPct != null && memPct > 85)
            ? 'increase_memory'
          : CONFIG_REASONS.has(termReason)
            ? 'check_config'
          : (exitCode === 127 || exitCode === 126)
            ? 'check_image'
          : 'investigate_logs';

        errors.push({
          type: 'HighRestarts', severity: count > 15 ? 'critical' : 'high',
          namespace: r.metric.namespace, pod: r.metric.pod,
          container: termContainer ?? exitInfo?.container ?? null,
          count, exitCode, restartRate, cpuMillicores,
          memUsedMi, memLimitMi, memPct,
          lastTermReason: termReason,
          suggestion,
        });
      }

      // ── CPU Throttling (> 60%) ────────────────────────────────────────────
      for (const r of (cpuThrottleRes ?? [])) {
        const throttlePct = +(parseFloat(r.value[1]) * 100).toFixed(0);
        if (throttlePct < 60) continue;
        const key = `throttle:${r.metric.namespace}/${r.metric.pod}:${r.metric.container}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const cpuMillicores = cpuMillicoresMap[`${r.metric.namespace}/${r.metric.pod}`] ?? null;
        errors.push({
          type: 'CPUThrottling', severity: throttlePct > 80 ? 'critical' : 'high',
          namespace: r.metric.namespace, pod: r.metric.pod,
          container: r.metric.container ?? null,
          count: throttlePct, throttlePct, cpuMillicores,
          suggestion: 'increase_cpu_limit',
        });
      }

      // ── Memory Near Limit (> 85%) ─────────────────────────────────────────
      for (const r of (memLimitRes ?? [])) {
        const podKey        = `${r.metric.namespace}/${r.metric.pod}`;
        const memUsedBytes  = memBytesMap[podKey] ?? null;
        const memLimitBytes = parseFloat(r.value[1]);
        if (!memUsedBytes || !memLimitBytes) continue;
        const memPct = +(memUsedBytes / memLimitBytes * 100).toFixed(0);
        if (memPct < 85) continue;
        if (seen.has(`oom:${podKey}`)) continue;
        const key = `memNear:${podKey}`;
        if (seen.has(key)) continue;
        seen.add(key);
        errors.push({
          type: 'MemNearLimit', severity: memPct > 95 ? 'critical' : 'high',
          namespace: r.metric.namespace, pod: r.metric.pod,
          container: null, count: memPct,
          memUsedMi:  +(memUsedBytes  / (1024 * 1024)).toFixed(0),
          memLimitMi: +(memLimitBytes / (1024 * 1024)).toFixed(0),
          memPct,
          suggestion: 'increase_memory',
        });
      }

      // ── ImagePullFailed ───────────────────────────────────────────────────
      for (const r of (imagePullRes ?? [])) {
        const key = `imgpull:${r.metric.namespace}/${r.metric.pod}`;
        if (seen.has(key)) continue;
        seen.add(key);
        errors.push({
          type: 'ImagePullFailed', severity: 'high',
          namespace: r.metric.namespace, pod: r.metric.pod,
          container: r.metric.container ?? null,
          count: 1, reason: r.metric.reason,
          suggestion: 'fix_image',
        });
      }

      // ── NodePressure ──────────────────────────────────────────────────────
      for (const r of (nodePressureRes ?? [])) {
        const key = `nodepressure:${r.metric.node}:${r.metric.condition}`;
        if (seen.has(key)) continue;
        seen.add(key);
        errors.push({
          type: 'NodePressure', severity: 'critical',
          namespace: null, pod: null,
          node: r.metric.node, container: null,
          count: 1, condition: r.metric.condition,
          suggestion: 'check_node',
        });
      }

      // Sort: critical first
      errors.sort((a, b) =>
        (a.severity === 'critical' ? 0 : 1) - (b.severity === 'critical' ? 0 : 1)
      );

      this._cache.set(cacheKey, { data: errors, expiresAt: Date.now() + CACHE_TTL_MS });
      return errors;
    } catch {
      return [];
    }
  }

  // ── Collect node metrics (single node) ──────────────────────────────────────
  async collectNodeMetrics(nodeName) {
    const cacheKey = `node:${nodeName}`;
    const cached   = this._cache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) return cached.data;

    if (!this.client.available) return null;

    try {
      const raw     = await this.client.getNodeMetrics(nodeName);
      const summary = this._aggregateNode(raw);
      this._cache.set(cacheKey, { data: summary, expiresAt: Date.now() + CACHE_TTL_MS });
      return summary;
    } catch {
      return null;
    }
  }

  // ── Collect all nodes metrics in one batch ────────────────────────────────────
  // Returns map: nodeName → { cpu, memory, disk, network }
  async collectAllNodesMetrics() {
    const cacheKey = 'batch:all-nodes';
    const cached   = this._cache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) return cached.data;

    if (!this.client.available) return null;

    try {
      const [cpuRes, memTotalRes, memAvailRes, diskTotalRes, diskAvailRes, netRxRes, netTxRes] =
        await Promise.all([
          // CPU utilization per node (fraction, 0–1)
          this.client.query(
            'sum by (instance) (rate(node_cpu_seconds_total{mode!="idle"}[5m])) / count by (instance) (node_cpu_seconds_total{mode="idle"})'
          ),
          // Memory total bytes
          this.client.query('node_memory_MemTotal_bytes'),
          // Memory available bytes
          this.client.query('node_memory_MemAvailable_bytes'),
          // Disk total bytes (root filesystem)
          this.client.query('node_filesystem_size_bytes{mountpoint="/",fstype!="tmpfs"}'),
          // Disk available bytes
          this.client.query('node_filesystem_avail_bytes{mountpoint="/",fstype!="tmpfs"}'),
          // Network receive bytes/s
          this.client.query('sum by (instance) (rate(node_network_receive_bytes_total{device!="lo"}[5m]))'),
          // Network transmit bytes/s
          this.client.query('sum by (instance) (rate(node_network_transmit_bytes_total{device!="lo"}[5m]))'),
        ]);

      const map = {};

      const _inst = r => r.metric?.instance?.replace(/:.*/, '') ?? r.metric?.node ?? null;

      const _set = (res, key, transform) => {
        for (const r of res ?? []) {
          const node = _inst(r);
          if (!node) continue;
          if (!map[node]) map[node] = {};
          map[node][key] = transform(parseFloat(r.value[1]));
        }
      };

      _set(cpuRes,      'cpuUsagePct',   v => +(v * 100).toFixed(1));
      _set(memTotalRes, 'memTotalBytes', v => v);
      _set(memAvailRes, 'memAvailBytes', v => v);
      _set(diskTotalRes,'diskTotalBytes',v => v);
      _set(diskAvailRes,'diskAvailBytes',v => v);
      _set(netRxRes,    'netRxBytesPerSec', v => +v.toFixed(0));
      _set(netTxRes,    'netTxBytesPerSec', v => +v.toFixed(0));

      // Compute derived fields
      for (const m of Object.values(map)) {
        if (m.memTotalBytes && m.memAvailBytes) {
          m.memUsedBytes = m.memTotalBytes - m.memAvailBytes;
          m.memUsedPct   = +((m.memUsedBytes / m.memTotalBytes) * 100).toFixed(1);
        }
        if (m.diskTotalBytes && m.diskAvailBytes) {
          m.diskUsedBytes = m.diskTotalBytes - m.diskAvailBytes;
          m.diskUsedPct   = +((m.diskUsedBytes / m.diskTotalBytes) * 100).toFixed(1);
        }
      }

      this._cache.set(cacheKey, { data: map, expiresAt: Date.now() + CACHE_TTL_MS });
      return map;
    } catch {
      return null;
    }
  }

  // ── Pod aggregation ──────────────────────────────────────────────────────────
  _aggregatePod(raw) {
    const cpuSeries  = this._flattenRange(raw.cpuRange);
    const memSeries  = this._flattenRange(raw.memRange);
    const restartVal = this._sumInstant(raw.restarts);
    const oomVal     = this._sumInstant(raw.oomCheck);

    const cpuCores = cpuSeries.map(parseFloat);
    const memBytes = memSeries.map(parseFloat);

    const cpuAvg    = this._avg(cpuCores);
    const cpuPeak   = this._peak(cpuCores);
    const memAvgMi  = this._avg(memBytes)  / (1024 * 1024);
    const memPeakMi = this._peak(memBytes) / (1024 * 1024);

    return {
      cpu: {
        avgCores:  +cpuAvg.toFixed(4),
        peakCores: +cpuPeak.toFixed(4),
        avgPct:    +(cpuAvg  * 100).toFixed(1),
        peakPct:   +(cpuPeak * 100).toFixed(1),
        trend:     this._trend(cpuCores),
      },
      memory: {
        avgMi:  +memAvgMi.toFixed(1),
        peakMi: +memPeakMi.toFixed(1),
        trend:  this._trend(memBytes),
      },
      restarts: {
        count: restartVal !== null ? Math.round(restartVal) : null,
      },
      oomDetected: oomVal !== null && oomVal > 0,
      collectedAt: new Date(),
    };
  }

  // ── Node aggregation ─────────────────────────────────────────────────────────
  _aggregateNode(raw) {
    const cpuSeries = this._flattenRange(raw.cpuRange);
    const memSeries = this._flattenRange(raw.memRange);

    const cpuCores  = cpuSeries.map(parseFloat);
    const memBytes  = memSeries.map(parseFloat);

    const pressureResults = raw.pressure || [];
    const pressureTypes   = pressureResults
      .map(r => r.metric?.condition)
      .filter(Boolean);

    return {
      node: raw.nodeName,
      cpu: {
        avgCores:  +this._avg(cpuCores).toFixed(3),
        peakCores: +this._peak(cpuCores).toFixed(3),
        trend:     this._trend(cpuCores),
      },
      memory: {
        avgMi:  +(this._avg(memBytes)  / (1024 * 1024)).toFixed(1),
        peakMi: +(this._peak(memBytes) / (1024 * 1024)).toFixed(1),
        trend:  this._trend(memBytes),
      },
      pressure: {
        any:   pressureTypes.length > 0,
        types: pressureTypes,
      },
      collectedAt: new Date(),
    };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  // Merge all time-series from a range result, summing values at the same timestamp.
  // This handles pods with multiple containers — their CPU/memory are summed per slot.
  _flattenRange(rangeResult) {
    if (!rangeResult?.length) return [];
    const byTs = new Map();
    for (const series of rangeResult) {
      for (const [ts, val] of (series.values || [])) {
        byTs.set(ts, (byTs.get(ts) || 0) + parseFloat(val));
      }
    }
    return [...byTs.values()];
  }

  // Sum the scalar value across all series in an instant query result.
  _sumInstant(instantResult) {
    if (!instantResult?.length) return null;
    return instantResult.reduce(
      (acc, r) => acc + parseFloat(r.value?.[1] ?? 0),
      0,
    );
  }

  _avg(values) {
    if (!values.length) return 0;
    return values.reduce((s, v) => s + v, 0) / values.length;
  }

  _peak(values) {
    if (!values.length) return 0;
    return Math.max(...values);
  }

  // Compare first-half average vs second-half average.
  // >10% growth → 'increasing', <−10% → 'decreasing', otherwise 'stable'.
  _trend(values) {
    if (values.length < 4) return 'unknown';
    const half      = Math.floor(values.length / 2);
    const firstAvg  = this._avg(values.slice(0, half));
    const secondAvg = this._avg(values.slice(-half));
    if (firstAvg === 0) return secondAvg > 0 ? 'increasing' : 'stable';
    const delta = (secondAvg - firstAvg) / firstAvg;
    if (delta >  0.10) return 'increasing';
    if (delta < -0.10) return 'decreasing';
    return 'stable';
  }
}

module.exports = new MetricsCollector();
