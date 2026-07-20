'use strict';
const express = require('express');
const clusterService = require('../../services/clusterService');
const provisionService = require('../../services/provisionService');
const kubectl = require('../../tools/kubectl');
const sessionManager = require('../../services/sessionManager');
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

// ── Test a kubeconfig's connectivity without saving anything (admin only) ───
// Lets the UI give immediate feedback while the admin is still filling in the form.
// Not a substitute for the check inside storeCredential() below — that one is the
// actual guarantee, this one is just faster feedback before committing.
router.post('/api/kube/clusters/test-credential', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { kubeconfig } = req.body;
  if (!kubeconfig?.trim()) return res.status(400).json({ error: 'kubeconfig is required' });
  try {
    await sessionManager.testConnection(kubeconfig);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
}));

// ── Upload/rotate a cluster's own kubeconfig (admin only) ───────────────────
// Hybrid path alongside the existing shared-kubeconfig model: this cluster's
// credential is stored encrypted and isolated (see services/sessionManager.js),
// never merged into the server's shared kubeconfig file. Registers/updates the
// cluster in clusters.yaml so the existing hot-reload (clusterConfig.onChange →
// orchestrator._reconcileAgents) picks it up automatically — no restart needed.
router.post('/api/kube/clusters/upload', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { name, kubeconfig, tier } = req.body;
  if (!name?.trim() || !kubeconfig?.trim())
    return res.status(400).json({ error: 'name and kubeconfig are required' });

  const trimmedName = name.trim();
  let context;
  try {
    context = await sessionManager.storeCredential({
      name: trimmedName, rawKubeconfig: kubeconfig, uploadedBy: req.user.email,
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const clusters = getClusters().filter(c => c.name !== trimmedName);
  clusters.push({ name: trimmedName, context, tier: tier ?? 'dev', namespaces: ['*'] });
  clusterService.validateAndSaveConfig(CONFIG_PATH, clusters);

  auditLogger.log({
    cluster:  trimmedName,
    agent:    'admin-console',
    action:   'upload_cluster_credential',
    decision: 'allowed',
    status:   'success',
    metadata: { requestedBy: req.user.email, context },
  });

  res.json({ ok: true, context });
}));

// ── Delete an uploaded cluster's credential (admin only) ─────────────────────
// Unlike unmonitoring via PUT /api/kube/clusters (which only removes the clusters.yaml
// entry), this actually deletes the encrypted secret from the database and its cached
// temp kubeconfig file — the only way to fully remove an uploaded cluster's credential.
// Only applies to credential-backed clusters; there's nothing to delete for clusters
// that reference the server's shared kubeconfig file (unmonitor those via Save Changes).
router.delete('/api/kube/clusters/credential/:context', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { context } = req.params;

  await sessionManager.deleteCredential(context);

  const clusters = getClusters().filter(c => c.context !== context);
  clusterService.validateAndSaveConfig(CONFIG_PATH, clusters);

  auditLogger.log({
    cluster:  context,
    agent:    'admin-console',
    action:   'delete_cluster_credential',
    decision: 'allowed',
    status:   'success',
    metadata: { requestedBy: req.user.email, context },
  });

  res.json({ ok: true });
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
