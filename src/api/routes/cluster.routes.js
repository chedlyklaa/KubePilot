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

router.get('/api/cluster/pods', requireAuth, asyncHandler(async (_req, res) => {
  res.json(await clusterService.getPodHealth(CONFIG_PATH));
}));

router.get('/api/cluster/namespaces/stream', requireAuth, asyncHandler(async (_req, res) => {
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();

  const clusters = clusterService.readConfig(CONFIG_PATH);
  res.write(JSON.stringify({
    type: 'init',
    clusters: clusters.map(c => ({ name: c.name, context: c.context, tier: c.tier ?? 'dev' })),
  }) + '\n');

  await clusterService.streamClusterNamespaces(CONFIG_PATH, cluster => {
    res.write(JSON.stringify({ type: 'cluster', cluster }) + '\n');
  });
  res.write(JSON.stringify({ type: 'done', timestamp: new Date().toISOString() }) + '\n');
  res.end();
}));

router.get('/api/cluster/:name/namespaces/:namespace/pods', requireAuth, asyncHandler(async (req, res) => {
  res.json(await clusterService.getNamespacePods(CONFIG_PATH, req.params.name, req.params.namespace));
}));

router.get('/api/kube/contexts', requireAuth, asyncHandler(async (_req, res) => {
  res.json({ contexts: await clusterService.getContexts(CONFIG_PATH) });
}));

router.put('/api/kube/clusters', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const existingByContext = Object.fromEntries(getClusters().map(c => [c.context, c]));
  const clusters = (req.body.clusters ?? []).map(c => {
    const prior = existingByContext[c.context];
    return prior ? { ...c, tier: prior.tier } : c;
  });
  clusterService.validateAndSaveConfig(CONFIG_PATH, clusters);
  res.json({ ok: true });
}));

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

  const existing = getClusters().find(c => c.name === trimmedName);
  const clusters = getClusters().filter(c => c.name !== trimmedName);
  clusters.push({ name: trimmedName, context, tier: existing ? existing.tier : (tier ?? 'dev'), namespaces: ['*'] });
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
