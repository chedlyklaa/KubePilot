'use strict';
const kubectl                 = require('../tools/kubectl');
const metricsCollector        = require('../monitoring/metricsCollector');
const ConnectivityAlertEngine = require('./connectivityAlertEngine');
const CapacityForecastEngine  = require('./capacityForecastEngine');
const RbacDriftEngine         = require('./rbacDriftEngine');
const RbacPostureEngine       = require('./rbacPostureEngine');
const WorkloadHardeningEngine = require('./workloadHardeningEngine');
const NetworkExposureEngine   = require('./networkExposureEngine');
const SecretsHygieneEngine    = require('./secretsHygieneEngine');

// Check if a feature flag is on
const _on = flag => process.env[flag] === 'true';

// Keep only entries that belong to this cluster
function _ownEntries(all, ownKeys) {
  if (!all) return {};
  return Object.fromEntries(Object.entries(all).filter(([key]) => ownKeys.has(key)));
}

async function _capacity(cluster, { nodeNames, podKeys }) {
  const [allNodeMetrics, allPodMetrics, hpas] = await Promise.all([
    metricsCollector.collectAllNodesMetrics().catch(() => null),
    metricsCollector.collectAllPodsMetrics().catch(() => null),
    kubectl.getHPAs('*', cluster.context)
      .then(items => items.map(h => ({
        namespace:       h.metadata?.namespace,
        currentReplicas: h.status?.currentReplicas ?? 0,
        maxReplicas:     h.spec?.maxReplicas ?? 0,
      })))
      .catch(() => null),
  ]);
  await CapacityForecastEngine.snapshotAndForecast({
    cluster:        cluster.name,
    allNodeMetrics: _ownEntries(allNodeMetrics, nodeNames),
    allPodMetrics:  _ownEntries(allPodMetrics, podKeys),
    hpas,
  });
}

// Run the background checks for one cluster
function runBackgroundChecks(cluster, reach) {
  const run = (label, fn) => Promise.resolve()
    .then(fn)
    .catch(err => console.warn(`[${cluster.name}] [${label}] Non-blocking error: ${err.message}`));

  if (_on('CONNECTIVITY_ALERTS_ENABLED')) {
    run('CONNECTIVITY', () => ConnectivityAlertEngine.check(cluster.name, reach.unreachable));
  }

  if (reach.unreachable) return;

  const target = { cluster: cluster.name, context: cluster.context };
  if (_on('CAPACITY_FORECAST_ENABLED'))  run('CAPACITY',           () => _capacity(cluster, reach));
  if (_on('RBAC_DRIFT_ENABLED'))         run('RBAC-DRIFT',         () => RbacDriftEngine.checkDrift(target));
  if (_on('RBAC_POSTURE_ENABLED'))       run('RBAC-POSTURE',       () => RbacPostureEngine.check(target));
  if (_on('WORKLOAD_HARDENING_ENABLED')) run('WORKLOAD-HARDENING', () => WorkloadHardeningEngine.check(target));
  if (_on('NETWORK_EXPOSURE_ENABLED'))   run('NETWORK-EXPOSURE',   () => NetworkExposureEngine.check(target));
  if (_on('SECRETS_HYGIENE_ENABLED'))    run('SECRETS-HYGIENE',    () => SecretsHygieneEngine.check(target));
}

module.exports = { runBackgroundChecks, _ownEntries };
