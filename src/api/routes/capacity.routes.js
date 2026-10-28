'use strict';
const express = require('express');
const kubectl = require('../../tools/kubectl');
const clusterService = require('../../services/clusterService');
const capacityService = require('../../services/capacityService');
const capacityForecastEngine = require('../../agents/capacityForecastEngine');
const { getPodClient } = require('../../monitoring/podClientCache');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');

const router = express.Router();

router.get('/api/capacity/forecast', requireAuth, asyncHandler(async (req, res) => {
  const cluster = req.query.cluster || null;
  if (!cluster) return res.status(400).json({ error: 'cluster query param required' });

  if (process.env.CAPACITY_FORECAST_ENABLED !== 'true')
    return res.json({ enabled: false, forecast: null });

  const forecast = await capacityForecastEngine.getForecast(cluster);
  res.json({ enabled: true, cluster, forecast: forecast ?? null });
}));

router.get('/api/capacity/history', requireAuth, asyncHandler(async (req, res) => {
  const { cluster, target, hours } = req.query;
  if (!cluster || !target) return res.status(400).json({ error: 'cluster and target query params required' });

  if (process.env.CAPACITY_FORECAST_ENABLED !== 'true')
    return res.json({ enabled: false, snapshots: [] });

  const snapshots = await capacityForecastEngine.getHistory({
    cluster,
    target,
    hours: Math.min(720, parseInt(hours ?? '48', 10)),
  });
  res.json({ enabled: true, cluster, target, snapshots });
}));

router.get('/api/capacity/overview', requireAuth, asyncHandler(async (req, res) => {
  const clusterName = req.query.cluster;
  if (!clusterName) return res.status(400).json({ error: 'cluster required' });
  const result = await capacityService.getCapacityOverview(clusterName, {
    clusterService,
    kubectl,
    capacityForecastEngine,
    promClientGetter: getPodClient,
  });
  if (!result) return res.status(404).json({ error: 'cluster not found' });
  res.json(result);
}));

module.exports = router;
