import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

process.env.NOTIFICATION_SECRET ??= 'test-only-secret-not-a-real-value-0123456789';

const require = createRequire(import.meta.url);
const { runBackgroundChecks, _ownEntries } = require('./backgroundChecks.js');
const connectivity = require('./connectivityAlertEngine.js');
const capacity     = require('./capacityForecastEngine.js');
const rbacDrift    = require('./rbacDriftEngine.js');
const engines = {
  rbacPosture:       require('./rbacPostureEngine.js'),
  workloadHardening: require('./workloadHardeningEngine.js'),
  networkExposure:   require('./networkExposureEngine.js'),
  secretsHygiene:    require('./secretsHygieneEngine.js'),
};

const FLAGS = [
  'CONNECTIVITY_ALERTS_ENABLED', 'CAPACITY_FORECAST_ENABLED', 'RBAC_DRIFT_ENABLED', 'RBAC_POSTURE_ENABLED',
  'WORKLOAD_HARDENING_ENABLED', 'NETWORK_EXPOSURE_ENABLED', 'SECRETS_HYGIENE_ENABLED',
];
const cluster = { name: 'dev', context: 'dev-ctx' };
const reachable = { unreachable: false, nodeNames: new Set(), podKeys: new Set() };
const tick = () => new Promise(r => setTimeout(r, 0));

let saved, calls, restore;
beforeEach(() => {
  saved = Object.fromEntries(FLAGS.map(f => [f, process.env[f]]));
  calls = [];
  restore = [];
  const stub = (obj, key, label) => {
    const orig = obj[key];
    obj[key] = async (...args) => { calls.push([label, ...args]); };
    restore.push(() => { obj[key] = orig; });
  };
  // Replace a method with a fixed value
  const fixed = (obj, key, value) => {
    const orig = obj[key];
    obj[key] = async () => value;
    restore.push(() => { obj[key] = orig; });
  };
  fixed(require('../monitoring/metricsCollector.js'), 'collectAllNodesMetrics', {});
  fixed(require('../monitoring/metricsCollector.js'), 'collectAllPodsMetrics', {});
  fixed(require('../tools/kubectl.js'), 'getHPAs', []);
  stub(connectivity, 'check', 'connectivity');
  stub(capacity, 'snapshotAndForecast', 'capacity');
  stub(rbacDrift, 'checkDrift', 'rbacDrift');
  for (const [label, e] of Object.entries(engines)) stub(e, 'check', label);
});
afterEach(() => {
  for (const r of restore) r();
  for (const f of FLAGS) { if (saved[f] === undefined) delete process.env[f]; else process.env[f] = saved[f]; }
});

describe('runBackgroundChecks', () => {
  it('runs nothing when every flag is off', async () => {
    for (const f of FLAGS) delete process.env[f];
    runBackgroundChecks(cluster, reachable);
    await tick();
    expect(calls).toEqual([]);
  });

  it('runs each enabled engine for the cluster', async () => {
    for (const f of FLAGS) process.env[f] = 'true';
    runBackgroundChecks(cluster, reachable);
    await tick(); await tick();
    const labels = calls.map(c => c[0]).sort();
    expect(labels).toEqual(['capacity', 'connectivity', 'networkExposure', 'rbacDrift', 'rbacPosture', 'secretsHygiene', 'workloadHardening']);
    expect(calls.find(c => c[0] === 'rbacPosture')[1]).toEqual({ cluster: 'dev', context: 'dev-ctx' });
  });

  it('only reports connectivity for an unreachable cluster', async () => {
    for (const f of FLAGS) process.env[f] = 'true';
    runBackgroundChecks(cluster, { ...reachable, unreachable: true });
    await tick(); await tick();
    expect(calls).toEqual([['connectivity', 'dev', true]]);
  });

  it('swallows an engine failure instead of throwing into the fleet cycle', async () => {
    process.env.RBAC_POSTURE_ENABLED = 'true';
    engines.rbacPosture.check = async () => { throw new Error('boom'); };
    expect(() => runBackgroundChecks(cluster, reachable)).not.toThrow();
    await tick();
  });
});

describe('_ownEntries', () => {
  it('keeps only the metrics that belong to this cluster', () => {
    const all = { 'node-a': { cpu: 1 }, '10.0.0.1': { cpu: 1 }, 'node-b': { cpu: 2 } };
    expect(_ownEntries(all, new Set(['node-a']))).toEqual({ 'node-a': { cpu: 1 } });
    expect(_ownEntries(null, new Set(['node-a']))).toEqual({});
  });
});

describe('engine throttles are per cluster', () => {
  it('scans every cluster, not just the one whose calls land on every Nth count', async () => {
    for (const r of restore) r();
    restore = [];
    const scanned = [];
    for (const e of Object.values(engines)) {
      const orig = e.rescanNow;
      e.rescanNow = async ({ cluster: c }) => { scanned.push(c); };
      restore.push(() => { e.rescanNow = orig; });
    }
    for (let i = 0; i < 10; i++) {
      for (const e of Object.values(engines)) {
        await e.check({ cluster: 'alpha', context: 'a' });
        await e.check({ cluster: 'beta', context: 'b' });
      }
    }
    for (const c of ['alpha', 'beta']) expect(scanned.filter(s => s === c)).toHaveLength(Object.keys(engines).length);
  });
});
