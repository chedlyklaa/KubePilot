'use strict';
const express = require('express');
const kubectl = require('../../tools/kubectl');
const auditLogger = require('../../audit/logger');
const { getClusters } = require('../../config/clusterConfig');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');

const router = express.Router();

function _clusterContext(name) {
  const cluster = getClusters().find(c => c.name === name);
  if (!cluster) throw Object.assign(new Error('Cluster not found or not monitored'), { status: 404 });
  return cluster.context;
}

// GET /api/autoscaling/hpas?cluster=NAME
router.get('/api/autoscaling/hpas', requireAuth, asyncHandler(async (req, res) => {
  const { cluster } = req.query;
  if (!cluster) return res.status(400).json({ error: 'cluster is required' });
  const context = _clusterContext(cluster);

  const [hpas, metricsAvailable] = await Promise.all([
    kubectl.getHPAs('*', context),
    kubectl.isMetricsServerAvailable(context),
  ]);

  const items = hpas.map(h => {
    const spec   = h.spec   ?? {};
    const status = h.status ?? {};
    const cpuTarget  = spec.metrics?.find(m => m.resource?.name === 'cpu')?.resource?.target?.averageUtilization
      ?? spec.targetCPUUtilizationPercentage ?? null;
    const cpuCurrent = status.currentMetrics?.find(m => m.resource?.name === 'cpu')?.resource?.current?.averageUtilization
      ?? status.currentCPUUtilizationPercentage ?? null;

    // Stuck if the metrics API isn't being served at all, or the HPA hasn't managed to
    // read any metric in its own status — either way, it's silently doing nothing.
    const noMetricsYet = !status.currentMetrics?.length && cpuCurrent == null;
    const stuck = !metricsAvailable || noMetricsYet;

    return {
      name:            h.metadata?.name,
      namespace:       h.metadata?.namespace,
      target:          `${spec.scaleTargetRef?.kind ?? '?'}/${spec.scaleTargetRef?.name ?? '?'}`,
      minReplicas:     spec.minReplicas ?? 1,
      maxReplicas:     spec.maxReplicas ?? null,
      currentReplicas: status.currentReplicas ?? 0,
      desiredReplicas: status.desiredReplicas ?? 0,
      cpuTarget,
      cpuCurrent,
      stuck,
      conditions: (status.conditions ?? []).map(c => ({ type: c.type, status: c.status, reason: c.reason, message: c.message })),
    };
  });

  res.json({ metricsAvailable, hpas: items });
}));

// PUT /api/autoscaling/hpas/:name  { cluster, namespace, minReplicas, maxReplicas }
router.put('/api/autoscaling/hpas/:name', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { cluster, namespace, minReplicas, maxReplicas } = req.body;
  if (!cluster || !namespace) return res.status(400).json({ error: 'cluster and namespace are required' });
  const context = _clusterContext(cluster);

  await kubectl.patchHPA(req.params.name, namespace, { minReplicas, maxReplicas }, context);

  auditLogger.log({
    cluster, agent: 'admin-console', action: 'patch_hpa', decision: 'allowed', status: 'success',
    metadata: { requestedBy: req.user.email, hpa: req.params.name, namespace, minReplicas, maxReplicas },
  });

  res.json({ ok: true });
}));

module.exports = router;
