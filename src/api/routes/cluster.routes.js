'use strict';
const express = require('express');
const clusterService = require('../../services/clusterService');
const provisionService = require('../../services/provisionService');
const kubectl = require('../../tools/kubectl');
const auditLogger = require('../../audit/logger');
const { User } = require('../../db/models');
const { CONFIG_PATH, getClusters } = require('../../config/clusterConfig');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');

const router = express.Router();

// ── Cluster pod health ────────────────────────────────────────────────────
router.get('/api/cluster/pods', requireAuth, asyncHandler(async (_req, res) => {
  res.json(await clusterService.getPodHealth(CONFIG_PATH));
}));

// ── Kubernetes context discovery ────────────────────────────────────────────
router.get('/api/kube/contexts', requireAuth, asyncHandler(async (_req, res) => {
  res.json({ contexts: await clusterService.getContexts(CONFIG_PATH) });
}));

// ── Update monitored clusters config (admin only) ────────────────────────
router.put('/api/kube/clusters', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  clusterService.validateAndSaveConfig(CONFIG_PATH, req.body.clusters);
  res.json({ ok: true });
}));

// ── Download a monitored cluster's own kubeconfig (admin only) ──────────────
// Exports the exact credentials KubePilot itself uses for this cluster — full
// access, not scoped to any one user — so this must stay admin-gated and audited.
router.get('/api/kube/clusters/:name/kubeconfig', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const cluster = getClusters().find(c => c.name === req.params.name);
  if (!cluster) return res.status(404).json({ error: 'Cluster not found or not monitored' });

  const kubeconfig = await kubectl.getRawKubeconfig(cluster.context);

  auditLogger.log({
    cluster:  cluster.name,
    agent:    'admin-console',
    action:   'download_cluster_kubeconfig',
    decision: 'allowed',
    status:   'success',
    metadata: { requestedBy: req.user.email, context: cluster.context },
  });

  res.setHeader('Content-Disposition', `attachment; filename="kubeconfig-${cluster.name}.yaml"`);
  res.setHeader('Content-Type', 'application/yaml');
  res.send(kubeconfig);
}));

// ── Cluster provisioning (admin or users with canProvision flag) ────────────
router.post('/api/cluster/provision/start', requireAuth, asyncHandler(async (req, res) => {
  if (req.user.role !== 'admin') {
    const u = await User.findById(req.user.id).select('canProvision').lean();
    if (!u?.canProvision) return res.status(403).json({ error: 'You don\'t have permission to create clusters. Ask your admin to enable it.' });
  }
  const jobId = provisionService.startJob(req.body.profile, req.body.tier, req.user.name, CONFIG_PATH);
  res.json({ jobId });
}));

router.get('/api/cluster/provision/status', requireAuth, (req, res) => {
  const job = provisionService.getJob(req.query.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  res.json({ status: job.status, log: job.log, error: job.error ?? null, profile: job.profile });
});

module.exports = router;
