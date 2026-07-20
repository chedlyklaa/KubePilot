'use strict';
const express = require('express');
const kubectl = require('../../tools/kubectl');
const helm = require('../../tools/helm');
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

// GET /api/extensions/crds?cluster=NAME
router.get('/api/extensions/crds', requireAuth, asyncHandler(async (req, res) => {
  const { cluster } = req.query;
  if (!cluster) return res.status(400).json({ error: 'cluster is required' });
  const context = _clusterContext(cluster);

  const crds = await kubectl.getCRDs(context);
  res.json({
    crds: crds.map(c => ({
      name:     c.metadata?.name,
      group:    c.spec?.group,
      kind:     c.spec?.names?.kind,
      plural:   c.spec?.names?.plural,
      scope:    c.spec?.scope,
      versions: (c.spec?.versions ?? []).map(v => v.name),
      age:      c.metadata?.creationTimestamp,
    })),
  });
}));

// GET /api/extensions/helm?cluster=NAME
router.get('/api/extensions/helm', requireAuth, asyncHandler(async (req, res) => {
  const { cluster } = req.query;
  if (!cluster) return res.status(400).json({ error: 'cluster is required' });
  const context = _clusterContext(cluster);

  if (!(await helm.isHelmAvailable())) {
    return res.json({ available: false, releases: [] });
  }

  try {
    const releases = await helm.listReleases(context);
    res.json({
      available: true,
      releases: releases.map(r => ({
        name:       r.name,
        namespace:  r.namespace,
        chart:      r.chart,
        appVersion: r.app_version,
        revision:   r.revision,
        status:     r.status,
        updated:    r.updated,
      })),
    });
  } catch (err) {
    // helm is installed but the list command itself failed (e.g. bad kube-context) —
    // surface it, but don't 500 the whole page over it.
    res.json({ available: true, releases: [], error: err.message });
  }
}));

// POST /api/extensions/helm/:release/rollback  { cluster, namespace }
router.post('/api/extensions/helm/:release/rollback', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { cluster, namespace } = req.body;
  if (!cluster || !namespace) return res.status(400).json({ error: 'cluster and namespace are required' });
  const context = _clusterContext(cluster);

  await helm.rollbackRelease(req.params.release, namespace, context);

  auditLogger.log({
    cluster, agent: 'admin-console', action: 'helm_rollback', decision: 'allowed', status: 'success',
    metadata: { requestedBy: req.user.email, release: req.params.release, namespace },
  });

  res.json({ ok: true });
}));

module.exports = router;
