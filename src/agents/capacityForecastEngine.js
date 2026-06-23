'use strict';

let MetricSnapshot        = null;
let CapacityForecastCache = null;
let _notifEngine          = null;

function _initModels() {
  if (MetricSnapshot) return;
  try {
    ({ MetricSnapshot, CapacityForecastCache } = require('../db/models'));
  } catch { /* MongoDB unavailable — snapshots will be skipped */ }
}

function _getNotifEngine() {
  if (!_notifEngine) {
    try { _notifEngine = require('../services/notifications/engine'); } catch {}
  }
  return _notifEngine;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const FORECAST_INTERVAL_CYCLES = parseInt(process.env.FORECAST_INTERVAL_CYCLES ?? '5', 10);
const FORECAST_LOOKBACK_HOURS  = parseInt(process.env.FORECAST_LOOKBACK_HOURS  ?? '168', 10);
const FORECAST_MIN_DATAPOINTS  = parseInt(process.env.FORECAST_MIN_DATAPOINTS  ?? '10',  10);
const CONFIDENCE_GATE_MIN      = 12; // below this count, downgrade alert level by one step

// Alert thresholds (percentage)
const THRESHOLDS = {
  memory: { WARNING: 80, HIGH: 90, CRITICAL: 95 },
  cpu:    { WARNING: 75, HIGH: 85, CRITICAL: 92 },
  disk:   { WARNING: 70, HIGH: 82, CRITICAL: 90 },
};

// Hours-to-exhaustion alert bands
const ETA_BANDS = { CRITICAL: 6, HIGH: 24, WARNING: 72 };

const LEVEL_ORDER = { OK: 0, WARNING: 1, HIGH: 2, CRITICAL: 3 };
const LEVEL_NAMES = ['OK', 'WARNING', 'HIGH', 'CRITICAL'];

// ── Spike suppression ─────────────────────────────────────────────────────────
// Drops any data point where the jump from the previous point exceeds SPIKE_THRESHOLD%.
// This prevents a single CPU burst or batch job from distorting a long-window regression.
const SPIKE_THRESHOLD = 30;

function _despiked(snapshots, resourceKey) {
  const raw = snapshots.filter(s => s[resourceKey] != null);
  if (raw.length === 0) return [];
  const clean = [raw[0]];
  for (let i = 1; i < raw.length; i++) {
    if (Math.abs(raw[i][resourceKey] - raw[i - 1][resourceKey]) <= SPIKE_THRESHOLD) {
      clean.push(raw[i]);
    }
  }
  return clean;
}

// ── Weighted Linear Regression ─────────────────────────────────────────────────
// Returns { slope (% / hour), currentPct, hoursToExhaustion, exhaustionAt } or null.
function wlrForecast(snapshots, resourceKey) {
  const valid = _despiked(snapshots, resourceKey);
  if (valid.length < FORECAST_MIN_DATAPOINTS) return null;

  const t0 = valid[0].createdAt.getTime();
  const n  = valid.length;

  const xs = valid.map(s => (s.createdAt.getTime() - t0) / 3_600_000);
  const ys = valid.map(s => s[resourceKey]);
  const ws = xs.map((_, i) => 1 + i / n);

  let Sw = 0, Swx = 0, Swy = 0, Swxx = 0, Swxy = 0;
  for (let i = 0; i < n; i++) {
    Sw   += ws[i];
    Swx  += ws[i] * xs[i];
    Swy  += ws[i] * ys[i];
    Swxx += ws[i] * xs[i] * xs[i];
    Swxy += ws[i] * xs[i] * ys[i];
  }

  const det = Sw * Swxx - Swx * Swx;
  if (Math.abs(det) < 1e-10) return null;

  const slope     = (Sw * Swxy - Swx * Swy) / det;
  const intercept = (Swy - slope * Swx) / Sw;
  const currentPct = ys[n - 1];

  if (slope <= 0) return null;

  let hoursToExhaustion = (100 - intercept) / slope;
  let exhaustionAt      = null;
  if (hoursToExhaustion > 0 && hoursToExhaustion < 8760) {
    exhaustionAt = new Date(t0 + hoursToExhaustion * 3_600_000);
  } else {
    hoursToExhaustion = null;
  }

  return { slope: +slope.toFixed(4), currentPct, hoursToExhaustion, exhaustionAt, model: 'wlr' };
}

// ── EWMA short-window forecast ────────────────────────────────────────────────
// Uses the last 6 hours of data with exponential smoothing (α = 0.3).
// Detects rapid trends (memory leaks, runaway processes) that the 7-day WLR window misses.
function ewmaForecast(snapshots, resourceKey, alpha = 0.3) {
  const sixHoursAgo = Date.now() - 6 * 3_600_000;
  const raw    = snapshots.filter(s => s[resourceKey] != null && s.createdAt.getTime() >= sixHoursAgo);
  const recent = _despiked(raw, resourceKey); // spike-suppress the short window too
  if (recent.length < 3) return null;

  // Build EWMA series
  const ewmaVals = [recent[0][resourceKey]];
  for (let i = 1; i < recent.length; i++) {
    ewmaVals.push(alpha * recent[i][resourceKey] + (1 - alpha) * ewmaVals[i - 1]);
  }

  const n = ewmaVals.length;
  const deltaHours = (recent[n - 1].createdAt.getTime() - recent[0].createdAt.getTime()) / 3_600_000;
  if (deltaHours < 0.05) return null; // window too narrow — can't derive a reliable slope

  const slope = (ewmaVals[n - 1] - ewmaVals[0]) / deltaHours;
  if (slope <= 0) return null;

  const currentPct        = recent[n - 1][resourceKey];
  const hoursToExhaustion = (100 - currentPct) / slope;
  if (hoursToExhaustion <= 0 || hoursToExhaustion > 8760) return null;

  return {
    slope: +slope.toFixed(4),
    currentPct,
    hoursToExhaustion: +hoursToExhaustion.toFixed(1),
    exhaustionAt: new Date(Date.now() + hoursToExhaustion * 3_600_000),
    model: 'ewma',
  };
}

// ── Alert level computation ────────────────────────────────────────────────────
function computeAlertLevel(resource, currentPct, hoursToExhaustion) {
  const t = THRESHOLDS[resource] ?? THRESHOLDS.memory;

  let stateLevel = 'OK';
  if (currentPct >= t.CRITICAL)     stateLevel = 'CRITICAL';
  else if (currentPct >= t.HIGH)    stateLevel = 'HIGH';
  else if (currentPct >= t.WARNING) stateLevel = 'WARNING';

  let forecastLevel = 'OK';
  if (hoursToExhaustion != null) {
    if (hoursToExhaustion <= ETA_BANDS.CRITICAL)     forecastLevel = 'CRITICAL';
    else if (hoursToExhaustion <= ETA_BANDS.HIGH)    forecastLevel = 'HIGH';
    else if (hoursToExhaustion <= ETA_BANDS.WARNING) forecastLevel = 'WARNING';
  }

  return LEVEL_ORDER[forecastLevel] >= LEVEL_ORDER[stateLevel] ? forecastLevel : stateLevel;
}

// ── Confidence band ────────────────────────────────────────────────────────────
function dataConfidence(count) {
  if (count >= 168) return 'HIGH';
  if (count >= 48)  return 'MEDIUM';
  return 'LOW';
}

// ── Human-readable absolute value ─────────────────────────────────────────────
function fmtAbs(bytes) {
  if (bytes == null) return null;
  if (bytes < 1024)       return `${bytes}B`;
  if (bytes < 1024 ** 2)  return `${(bytes / 1024).toFixed(0)}Ki`;
  if (bytes < 1024 ** 3)  return `${(bytes / 1024 ** 2).toFixed(0)}Mi`;
  return `${(bytes / 1024 ** 3).toFixed(2)}Gi`;
}

// ── Hybrid forecast result ─────────────────────────────────────────────────────
// Runs both WLR and EWMA, picks the more conservative (lower ETA) result.
// Applies confidence gating (sparse data → downgrade alert level by one step).
function buildForecastResult({ targetType, target, namespace, cluster, resource, snapshots, lookbackHours }) {
  const keyMap = { memory: 'memPct', cpu: 'cpuPct', disk: 'diskPct' };
  const absMap = { memory: 'memAbs', cpu: 'cpuAbs', disk: null };
  const resourceKey = keyMap[resource];
  if (!resourceKey) return null;

  const wlr  = wlrForecast(snapshots, resourceKey);
  const ewma = ewmaForecast(snapshots, resourceKey);

  if (!wlr && !ewma) return null;

  // Pick the model with lower (more urgent) ETA — conservative hybrid
  let chosen = wlr;
  if (ewma && (!wlr || ewma.hoursToExhaustion < (wlr.hoursToExhaustion ?? Infinity))) {
    chosen = ewma;
  }

  const { slope, currentPct, hoursToExhaustion } = chosen;
  const exhaustionAt = chosen.exhaustionAt instanceof Date
    ? chosen.exhaustionAt.toISOString()
    : (chosen.exhaustionAt ?? null);

  let alertLevel = computeAlertLevel(resource, currentPct, hoursToExhaustion);

  // Confidence gating: when data is sparse, downgrade alert level one step.
  // Prevents a handful of noisy readings from generating false CRITICAL alerts.
  if (snapshots.length < CONFIDENCE_GATE_MIN && alertLevel !== 'OK') {
    const idx = LEVEL_NAMES.indexOf(alertLevel);
    alertLevel = LEVEL_NAMES[Math.max(0, idx - 1)];
  }

  // Suppress weak signals that are not actionable
  if (alertLevel === 'OK' && (!hoursToExhaustion || hoursToExhaustion > 168)) return null;

  const absKey     = absMap[resource];
  const lastSnap   = snapshots[snapshots.length - 1];
  const currentAbs = absKey ? fmtAbs(lastSnap?.[absKey]) : null;

  const modelVersion = wlr && ewma
    ? (chosen.model === 'ewma' ? 'hybrid-ewma' : 'hybrid-wlr')
    : (chosen.model === 'ewma' ? 'ewma-v1' : 'wlr-v2');

  return {
    targetType,
    target,
    namespace,
    cluster,
    resource,
    currentPct:        +currentPct.toFixed(1),
    currentAbs,
    slope:             +slope.toFixed(3),
    hoursToExhaustion: hoursToExhaustion != null ? +hoursToExhaustion.toFixed(1) : null,
    exhaustionAt,
    alertLevel,
    dataPointCount:    snapshots.length,
    confidence:        dataConfidence(snapshots.length),
    lookbackHours,
    forecastedAt:      new Date().toISOString(),
    modelVersion,
  };
}

// ── CapacityForecastEngine ─────────────────────────────────────────────────────

class CapacityForecastEngine {
  constructor() {
    this._cycleCount  = 0;
    this._running     = false; // prevents concurrent forecast runs
    this._lastAlerted    = new Map(); // key → timestamp of last notification
    this._lastAlertLevel = new Map(); // key → last alert level (for recovery detection)
  }

  // ── Called from ClusterAgent.run() — non-blocking, fire-and-forget ──────────
  async snapshotAndForecast({ cluster, allNodeMetrics, allPodMetrics }) {
    if (process.env.CAPACITY_FORECAST_ENABLED !== 'true') return;
    _initModels();

    this._cycleCount++;

    this._snapshot(cluster, allNodeMetrics, allPodMetrics).catch(err =>
      console.warn(`[CAPACITY] Snapshot failed (non-blocking): ${err.message}`)
    );

    if (this._cycleCount % FORECAST_INTERVAL_CYCLES !== 0) return;

    // Skip this cycle if the previous forecast is still computing
    if (this._running) {
      console.log('[CAPACITY] Previous forecast still running — skipping cycle');
      return;
    }
    this._running = true;

    try {
      const { forecast, allForecasts } = await this._forecast(cluster);
      if (!forecast) return;

      if (CapacityForecastCache) {
        await CapacityForecastCache.findOneAndUpdate(
          { cluster },
          { forecast, computedAt: new Date() },
          { upsert: true }
        );
      }

      const notifEngine = _getNotifEngine();
      if (notifEngine) {
        for (const fc of forecast.criticalForecasts ?? []) {
          this._maybeNotify(fc, notifEngine);
        }
        this._checkRecoveries(cluster, allForecasts, notifEngine);
      }

      console.log(
        `[CAPACITY] Forecast: cluster=${cluster}` +
        ` critical=${forecast.summary.criticalCount}` +
        ` high=${forecast.summary.highCount}` +
        ` warning=${forecast.summary.warningCount}`
      );
    } catch (err) {
      console.warn(`[CAPACITY] Forecast failed (non-blocking): ${err.message}`);
    } finally {
      this._running = false;
    }
  }

  // ── On-demand: save a snapshot from live metrics and compute a forecast ────
  // Called from the capacity overview endpoint so data accumulates on every page load.
  async liveSnapshotAndForecast(cluster, nodeMetrics, podMetrics) {
    _initModels();
    if (!MetricSnapshot) return null;
    await this._snapshot(cluster, nodeMetrics, podMetrics).catch(() => {});
    try {
      const { forecast } = await this._forecast(cluster);
      if (forecast && CapacityForecastCache) {
        await CapacityForecastCache.findOneAndUpdate(
          { cluster }, { forecast, computedAt: new Date() }, { upsert: true }
        );
      }
      return forecast;
    } catch { return null; }
  }

  // ── Get the latest cached forecast (for API + RCA injection) ───────────────
  async getForecast(cluster) {
    _initModels();
    if (!CapacityForecastCache) return null;
    try {
      const doc = await CapacityForecastCache.findOne({ cluster }).lean();
      return doc?.forecast ?? null;
    } catch {
      return null;
    }
  }

  // ── Get raw snapshots for a target (sparkline data) ─────────────────────────
  async getHistory({ cluster, target, hours = 48 }) {
    _initModels();
    if (!MetricSnapshot) return [];
    try {
      const since = new Date(Date.now() - hours * 3_600_000);
      return await MetricSnapshot.find({ cluster, target, createdAt: { $gte: since } })
        .sort({ createdAt: 1 })
        .lean();
    } catch {
      return [];
    }
  }

  // ── Persist one snapshot document per node + pod in this cycle ──────────────
  async _snapshot(cluster, allNodeMetrics, allPodMetrics) {
    if (!MetricSnapshot) return;

    const docs = [];
    const now  = new Date();

    for (const [nodeName, m] of Object.entries(allNodeMetrics ?? {})) {
      if (/^\d+\.\d+\.\d+\.\d+$/.test(nodeName)) continue;
      docs.push({
        cluster,
        namespace: '',
        target:    `node:${nodeName}`,
        targetType:'node',
        cpuPct:    m.cpuUsagePct   ?? null,
        memPct:    m.memUsedPct    ?? null,
        diskPct:   m.diskUsedPct   ?? null,
        cpuAbs:    m.cpuUsagePct   ?? null,
        memAbs:    m.memUsedBytes  ?? null,
        createdAt: now,
      });
    }

    for (const [key, m] of Object.entries(allPodMetrics ?? {})) {
      const [namespace, pod] = key.split('/');
      docs.push({
        cluster,
        namespace: namespace ?? '',
        target:    `pod:${pod}`,
        targetType:'pod',
        cpuPct:    null,
        memPct:    null,
        diskPct:   null,
        cpuAbs:    m.cpuCores ?? null,
        memAbs:    m.memBytes ?? null,
        createdAt: now,
      });
    }

    if (docs.length === 0) return;
    await MetricSnapshot.insertMany(docs, { ordered: false }).catch(() => {});
  }

  // ── Read snapshots and compute a full CapacityForecast ──────────────────────
  async _forecast(cluster) {
    if (!MetricSnapshot) return { forecast: null, allForecasts: [] };

    const since     = new Date(Date.now() - FORECAST_LOOKBACK_HOURS * 3_600_000);
    const snapshots = await MetricSnapshot.find({ cluster, createdAt: { $gte: since } })
      .sort({ createdAt: 1 })
      .lean();

    if (snapshots.length === 0) return { forecast: null, allForecasts: [] };

    const byTarget = new Map();
    for (const s of snapshots) {
      if (!byTarget.has(s.target)) byTarget.set(s.target, []);
      byTarget.get(s.target).push(s);
    }

    const allForecasts = [];
    const resources = { node: ['cpu', 'memory', 'disk'], pod: ['memory'] };

    for (const [target, snaps] of byTarget) {
      const sample    = snaps[0];
      const targetType = sample.targetType;
      const namespace  = sample.namespace ?? '';
      const resourcesToCheck = resources[targetType] ?? ['memory'];

      for (const resource of resourcesToCheck) {
        const result = buildForecastResult({
          targetType, target, namespace, cluster, resource,
          snapshots:    snaps,
          lookbackHours: FORECAST_LOOKBACK_HOURS,
        });
        if (result) allForecasts.push(result);
      }
    }

    allForecasts.sort((a, b) => (LEVEL_ORDER[b.alertLevel] ?? 0) - (LEVEL_ORDER[a.alertLevel] ?? 0));

    const criticalForecasts = allForecasts.filter(f => f.alertLevel === 'CRITICAL' || f.alertLevel === 'HIGH');

    const summary = {
      totalTargets:   byTarget.size,
      criticalCount:  allForecasts.filter(f => f.alertLevel === 'CRITICAL').length,
      highCount:      allForecasts.filter(f => f.alertLevel === 'HIGH').length,
      warningCount:   allForecasts.filter(f => f.alertLevel === 'WARNING').length,
      okCount:        allForecasts.filter(f => f.alertLevel === 'OK').length,
      nearestExhaustion: allForecasts.find(f => f.hoursToExhaustion != null) ?? null,
    };

    const pods      = {};
    const nodes     = {};
    const namespaces = {};
    for (const f of allForecasts) {
      const bucket = f.targetType === 'pod' ? pods : f.targetType === 'node' ? nodes : namespaces;
      if (!bucket[f.target]) bucket[f.target] = [];
      bucket[f.target].push(f);
    }

    const forecast = { cluster, forecastedAt: new Date().toISOString(), criticalForecasts, pods, nodes, namespaces, summary };
    return { forecast, allForecasts };
  }

  // ── Rate-limited notification ──────────────────────────────────────────────────
  _maybeNotify(fc, notifEngine) {
    const cooldownMs = parseInt(process.env.FORECAST_ALERT_COOLDOWN_MS ?? '14400000', 10);
    const key        = `${fc.cluster}:${fc.target}:${fc.resource}`;
    const lastAt     = this._lastAlerted.get(key) ?? 0;
    if (Date.now() - lastAt < cooldownMs) return;

    this._lastAlerted.set(key, Date.now());
    this._lastAlertLevel.set(key, fc.alertLevel);

    const eta = fc.hoursToExhaustion != null
      ? ` — exhaustion in ~${fc.hoursToExhaustion.toFixed(0)}h`
      : '';
    notifEngine.emit({
      severity: fc.alertLevel === 'CRITICAL' ? 'ERROR' : 'WARNING',
      category: 'Resource Usage',
      title:    `Capacity ${fc.alertLevel}: ${fc.target} ${fc.resource}`,
      message:  `${fc.target} ${fc.resource} at ${fc.currentPct}% (+${fc.slope}%/h)${eta}`,
      metadata: fc,
    }).catch(() => {});
  }

  // ── Alert recovery: fire a resolved notification when HIGH/CRITICAL drops to OK/WARNING ──
  _checkRecoveries(cluster, allForecasts, notifEngine) {
    for (const [key, lastLevel] of this._lastAlertLevel) {
      if (!key.startsWith(`${cluster}:`)) continue;
      if (LEVEL_ORDER[lastLevel] < 2) continue; // only track HIGH/CRITICAL recoveries

      // Parse key: "cluster:target:resource"
      // target itself may contain ':' (e.g. "node:worker-1") so take last segment as resource
      const withoutCluster = key.slice(cluster.length + 1);
      const lastColon      = withoutCluster.lastIndexOf(':');
      const target   = withoutCluster.slice(0, lastColon);
      const resource = withoutCluster.slice(lastColon + 1);

      const current      = allForecasts.find(f => f.target === target && f.resource === resource);
      const currentLevel = current?.alertLevel ?? 'OK';

      if (LEVEL_ORDER[currentLevel] < 2) {
        notifEngine.emit({
          severity: 'INFO',
          category: 'Resource Usage',
          title:    `Capacity Resolved: ${target} ${resource}`,
          message:  `${target} ${resource} is no longer in ${lastLevel} state. Current: ${current?.currentPct?.toFixed(1) ?? '?'}%`,
        }).catch(() => {});
        this._lastAlertLevel.set(key, currentLevel);
      }
    }
  }

  // ── Get the CRITICAL/HIGH forecast for a specific pod (for RCA injection) ────
  async getPodForecast(cluster, podName) {
    const forecast = await this.getForecast(cluster);
    if (!forecast) return null;
    const podKey = `pod:${podName}`;
    const results = forecast.pods?.[podKey] ?? [];
    const critical = results.find(r => r.alertLevel === 'CRITICAL' || r.alertLevel === 'HIGH');
    return critical ?? null;
  }
}

module.exports = new CapacityForecastEngine();
