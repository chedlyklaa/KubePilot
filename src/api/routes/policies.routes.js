'use strict';
const express = require('express');
const kubectl = require('../../tools/kubectl');
const { getClusters } = require('../../config/clusterConfig');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');

const router = express.Router();

function _clusterContext(name) {
  const cluster = getClusters().find(c => c.name === name);
  if (!cluster) throw Object.assign(new Error('Cluster not found or not monitored'), { status: 404 });
  return cluster.context;
}

router.get('/api/policies/overview', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { cluster } = req.query;
  if (!cluster) return res.status(400).json({ error: 'cluster is required' });
  const context = _clusterContext(cluster);

  const [quotas, pdbs, namespaces] = await Promise.all([
    kubectl.getResourceQuotas('*', context),
    kubectl.getPodDisruptionBudgets('*', context),
    kubectl.getNamespacesFull(context),
  ]);

  res.json({
    quotas: quotas.map(q => ({
      name:      q.metadata?.name,
      namespace: q.metadata?.namespace,
      hard:      q.status?.hard ?? {},
      used:      q.status?.used ?? {},
    })),
    pdbs: pdbs.map(p => ({
      name:                p.metadata?.name,
      namespace:           p.metadata?.namespace,
      minAvailable:        p.spec?.minAvailable   ?? null,
      maxUnavailable:      p.spec?.maxUnavailable ?? null,
      currentHealthy:      p.status?.currentHealthy      ?? null,
      desiredHealthy:      p.status?.desiredHealthy      ?? null,
      disruptionsAllowed:  p.status?.disruptionsAllowed  ?? null,
    })),
    podSecurity: namespaces
      .filter(ns => !['kube-system', 'kube-public', 'kube-node-lease'].includes(ns.metadata?.name))
      .map(ns => ({
        namespace: ns.metadata?.name,
        enforce:   ns.metadata?.labels?.['pod-security.kubernetes.io/enforce'] ?? null,
        warn:      ns.metadata?.labels?.['pod-security.kubernetes.io/warn']    ?? null,
        audit:     ns.metadata?.labels?.['pod-security.kubernetes.io/audit']   ?? null,
      })),
  });
}));

module.exports = router;
