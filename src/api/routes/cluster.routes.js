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

// Streams each cluster's namespace list as soon as it's ready, instead of waiting
// for the slowest cluster (see clusterService.streamClusterNamespaces). Namespaces
// are cheap to list (no pod bodies), so they're fetched eagerly on page load; pods
// are the expensive part and stay lazy — see /api/cluster/:name/namespaces/:namespace/pods
// below, which only runs once a namespace is actually expanded in the UI.
// Newline-delimited JSON over a plain fetch, not SSE/EventSource: this is a
// bounded, one-shot stream, and EventSource auto-reconnects on close, which would
// silently re-trigger the whole fetch loop every few seconds. Plain fetch also
// carries the normal Authorization header, so it needs no ticket dance.
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

// Lazy pod fetch for a single namespace of a single cluster — only called once the
// user expands that namespace's row in the UI, not on page load.
router.get('/api/cluster/:name/namespaces/:namespace/pods', requireAuth, asyncHandler(async (req, res) => {
  res.json(await clusterService.getNamespacePods(CONFIG_PATH, req.params.name, req.params.namespace));
}));

// ── Kubernetes context discovery ────────────────────────────────────────────
router.get('/api/kube/contexts', requireAuth, asyncHandler(async (_req, res) => {
  res.json({ contexts: await clusterService.getContexts(CONFIG_PATH) });
}));

// ── Update monitored clusters config (admin only) ────────────────────────
// Tier is set once, at first enablement/upload, and locked afterward — it feeds the
// policy/risk engines (production tier tightens approval gates), so letting it drift
// silently through a routine "manage clusters" save would undermine that guarantee.
// Any tier the client sends for an already-monitored context is ignored in favor of
// the stored value; only genuinely new contexts take the tier from the request.
router.put('/api/kube/clusters', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const existingByContext = Object.fromEntries(getClusters().map(c => [c.context, c]));
  const clusters = (req.body.clusters ?? []).map(c => {
    const prior = existingByContext[c.context];
    return prior ? { ...c, tier: prior.tier } : c;
  });
  clusterService.validateAndSaveConfig(CONFIG_PATH, clusters);
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

  // Rotating an existing cluster's credential (same name) must not let the tier
  // change along for the ride — only a genuinely new cluster takes the request's tier.
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
