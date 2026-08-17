'use strict';
const express = require('express');
const yaml = require('js-yaml');
const kubectl = require('../../tools/kubectl');
const { NetworkAuditLog } = require('../../db/models');
const { getClusters } = require('../../config/clusterConfig');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');

const router = express.Router();

// Context allow-list: only clusters configured in clusters.yaml can be targeted —
// same guard rbac.routes.js applies before touching kubectl.
function requireMonitoredContext(context, res) {
  const monitored = new Set(getClusters().map(c => c.context));
  if (!monitored.has(context)) {
    res.status(403).json({ error: 'Context not in monitored clusters' });
    return false;
  }
  return true;
}

// GET /api/network/overview?context=CTX&namespace=NS
// namespace=_all fetches across all namespaces (client filters)
router.get('/api/network/overview', requireAuth, asyncHandler(async (req, res) => {
  const { context, namespace = '_all' } = req.query;
  if (!context) return res.status(400).json({ error: 'context required' });
  if (!requireMonitoredContext(context, res)) return;
  const ns = namespace === '_all' ? '*' : namespace;

  const [networkPolicies, services, ingresses] = await Promise.all([
    kubectl.getNetworkPolicies(ns, context),
    kubectl.getServices(ns, context),
    kubectl.getIngresses(ns, context),
  ]);

  // Annotate server-side so the client doesn't need its own copy of the logic —
  // same reasoning as rbac.routes.js's `dangerous` flag on bindings.
  res.json({
    networkPolicies,
    services:  services.map(s => ({ ...s, exposed: ['NodePort', 'LoadBalancer'].includes(s.spec?.type) })),
    ingresses: ingresses.map(i => ({ ...i, noTls: !(i.spec?.tls?.length > 0) })),
  });
}));

const NETWORK_APPLY_KINDS = new Set(['NetworkPolicy', 'Service', 'Ingress']);

// POST /api/network/apply — apply one or more YAML documents (admin only)
router.post('/api/network/apply', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { yaml: yamlContent, context } = req.body;
  if (!yamlContent || !context)
    return res.status(400).json({ error: 'yaml and context required' });
  if (!requireMonitoredContext(context, res)) return;

  let docs;
  try {
    docs = yaml.loadAll(yamlContent).filter(d => d != null);
  } catch (e) {
    return res.status(400).json({ error: `Invalid YAML: ${e.message}` });
  }
  if (docs.length === 0)
    return res.status(400).json({ error: 'No documents found in YAML' });

  for (const doc of docs) {
    const kind = doc?.kind;
    if (!kind || !NETWORK_APPLY_KINDS.has(kind))
      return res.status(400).json({
        error: `Only NetworkPolicy, Service, and Ingress are permitted. Got kind: ${kind ?? '(none)'}`,
        invalidDocument: { kind, name: doc?.metadata?.name },
      });
  }

  let dryRunOutput;
  try {
    dryRunOutput = await kubectl.dryRunManifest(yamlContent, context);
  } catch (err) {
    return res.status(400).json({ error: 'Dry-run failed', detail: err.message });
  }

  const output = await kubectl.applyManifest(yamlContent, context);

  for (const doc of docs) {
    NetworkAuditLog.create({
      userId: req.user.id, userEmail: req.user.email,
      action: 'apply',
      kind: doc?.kind, name: doc?.metadata?.name, namespace: doc?.metadata?.namespace,
      context, yaml: yamlContent, timestamp: new Date(),
    }).catch(e => console.error('[Network Audit]', e.message));
  }

  res.json({ output, dryRunOutput, appliedCount: docs.length });
}));

// DELETE /api/network/resource — delete a network resource (admin only)
router.delete('/api/network/resource', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { kind, name, namespace, context } = req.body;
  if (!kind || !name || !context)
    return res.status(400).json({ error: 'kind, name, context required' });
  if (!requireMonitoredContext(context, res)) return;
  const output = await kubectl.deleteNetworkResource(kind, name, namespace, context);
  NetworkAuditLog.create({ userId: req.user.id, userEmail: req.user.email, action: 'delete', kind, name, namespace, context, timestamp: new Date() }).catch(e => console.error('[Network Audit]', e.message));
  res.json({ output });
}));

module.exports = router;
