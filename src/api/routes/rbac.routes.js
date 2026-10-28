'use strict';
const express = require('express');
const yaml = require('js-yaml');
const kubectl = require('../../tools/kubectl');
const { RbacAuditLog, User } = require('../../db/models');
const { getClusters } = require('../../config/clusterConfig');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const rbacSync = require('../../services/rbacSync');
const rbacWatcher = require('../../services/rbacWatcher');
const certIssuer = require('../../services/certIssuer');

const router = express.Router();

function isDangerous(roleName) {
  return ['cluster-admin', 'admin', 'edit'].includes(roleName) ||
    roleName.includes('cluster-admin');
}

// Make sure the context is a monitored cluster
function requireMonitoredContext(context, res) {
  const monitored = new Set(getClusters().map(c => c.context));
  if (!monitored.has(context)) {
    res.status(403).json({ error: 'Context not in monitored clusters' });
    return false;
  }
  return true;
}

router.get('/api/rbac/namespaces', requireAuth, asyncHandler(async (req, res) => {
  const { context } = req.query;
  if (!context) return res.status(400).json({ error: 'context required' });
  if (!requireMonitoredContext(context, res)) return;
  res.json(await kubectl.getNamespaces(context));
}));

router.get('/api/rbac/overview', requireAuth, asyncHandler(async (req, res) => {
  const { context, namespace = '_all', includeSystem } = req.query;
  if (!context) return res.status(400).json({ error: 'context required' });
  if (!requireMonitoredContext(context, res)) return;
  const ns = namespace === '_all' ? '*' : namespace;
  const [roles, clusterRoles, roleBindings, clusterRoleBindings, serviceAccounts] =
    await Promise.all([
      kubectl.getRoles(ns, context),
      kubectl.getClusterRoles(context),
      kubectl.getRoleBindings(ns, context),
      kubectl.getClusterRoleBindings(context),
      kubectl.getServiceAccounts(ns, context),
    ]);
  // Mark dangerous bindings
  const markDangerous = arr => arr.map(b => ({ ...b, dangerous: isDangerous(b.roleRef?.name ?? '') }));
  const filteredClusterRoles = includeSystem === 'true'
    ? clusterRoles
    : clusterRoles.filter(r => !r.metadata.name.startsWith('system:'));
  res.json({
    roles, clusterRoles: filteredClusterRoles, serviceAccounts,
    roleBindings:        markDangerous(roleBindings),
    clusterRoleBindings: markDangerous(clusterRoleBindings),
  });
}));

router.get('/api/rbac/audit', requireAuth, asyncHandler(async (req, res) => {
  const { context, namespace = '_all' } = req.query;
  if (!context) return res.status(400).json({ error: 'context required' });
  if (!requireMonitoredContext(context, res)) return;
  const ns = namespace === '_all' ? '*' : namespace;
  const [roleBindings, clusterRoleBindings] = await Promise.all([
    kubectl.getRoleBindings(ns, context),
    kubectl.getClusterRoleBindings(context),
  ]);
  const entries = [];
  for (const rb of roleBindings) {
    for (const subject of rb.subjects ?? []) {
      entries.push({
        subject:   subject.name,
        kind:      subject.kind,
        namespace: rb.metadata.namespace,
        role:      rb.roleRef.name,
        roleKind:  rb.roleRef.kind,
        scope:     'namespace',
        dangerous: isDangerous(rb.roleRef.name),
      });
    }
  }
  for (const crb of clusterRoleBindings) {
    for (const subject of crb.subjects ?? []) {
      entries.push({
        subject:   subject.name,
        kind:      subject.kind,
        namespace: subject.namespace ?? '*',
        role:      crb.roleRef.name,
        roleKind:  crb.roleRef.kind,
        scope:     'cluster',
        dangerous: isDangerous(crb.roleRef.name),
      });
    }
  }
  res.json(entries);
}));

const RBAC_APPLY_KINDS = new Set(['Role', 'ClusterRole', 'RoleBinding', 'ClusterRoleBinding', 'ServiceAccount']);

router.post('/api/rbac/apply', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
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
    if (!kind || !RBAC_APPLY_KINDS.has(kind))
      return res.status(400).json({
        error: `Only RBAC resources are permitted. Got kind: ${kind ?? '(none)'}`,
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
    RbacAuditLog.create({
      userId: req.user.id, userEmail: req.user.email,
      action: 'apply',
      kind: doc?.kind, name: doc?.metadata?.name, namespace: doc?.metadata?.namespace,
      context, yaml: yamlContent, timestamp: new Date(),
    }).catch(e => console.error('[RBAC Audit]', e.message));
  }

  res.json({ output, dryRunOutput, appliedCount: docs.length });
}));

router.delete('/api/rbac/resource', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { kind, name, namespace, context } = req.body;
  if (!kind || !name || !context)
    return res.status(400).json({ error: 'kind, name, context required' });
  if (!requireMonitoredContext(context, res)) return;
  const output = await kubectl.deleteRbacResource(kind, name, namespace, context);
  RbacAuditLog.create({ userId: req.user.id, userEmail: req.user.email, action: 'delete', kind, name, namespace, context, timestamp: new Date() }).catch(e => console.error('[RBAC Audit]', e.message));
  res.json({ output });
}));

router.get('/api/rbac/pending-changes', requireAuth, asyncHandler(async (_req, res) => {
  const clusters = getClusters().map(c => ({
    cluster:  c.name,
    context:  c.context,
    pending:  rbacWatcher.getPending(c.context),
  }));
  res.json({ clusters });
}));

router.get('/api/rbac/unmatched-users', requireAuth, requireAdmin, asyncHandler(async (_req, res) => {
  res.json({ users: rbacWatcher.getUnmatchedBacklog() });
}));

router.get('/api/rbac/multi-subject-advisories', requireAuth, requireAdmin, asyncHandler(async (_req, res) => {
  const advisories = [];
  for (const c of getClusters()) {
    advisories.push(...await rbacSync.getMultiSubjectAdvisories(c.context));
  }
  res.json({ advisories });
}));

router.post('/api/rbac/sync-from-k8s', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const results = [];

  for (const c of getClusters()) {
    try {
      results.push(await rbacSync.applyAndNotify(c.context, { actor: { userId: req.user.id, userEmail: req.user.email } }));
    } catch (err) {
      results.push({ cluster: c.name, context: c.context, error: err.message });
    }
  }

  res.json({ results });
}));

// Get the cluster name for a kubectl context
function _clusterNameForContext(context) {
  return getClusters().find(c => c.context === context)?.name ?? null;
}

router.post('/api/rbac/users/:userId/certificate', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { context } = req.body;
  if (!context) return res.status(400).json({ error: 'context required' });
  if (!requireMonitoredContext(context, res)) return;
  const clusterName = _clusterNameForContext(context);

  const target = await User.findById(req.params.userId).select('email').lean();
  if (!target) return res.status(404).json({ error: 'User not found' });

  const { kubeconfig } = await certIssuer.issueCertificate(req.params.userId, clusterName);

  RbacAuditLog.create({
    userId: req.user.id, userEmail: req.user.email,
    action: 'apply', kind: 'UserCertificate', name: target.email,
    context, timestamp: new Date(),
  }).catch(e => console.error('[RBAC Audit]', e.message));

  res.setHeader('Content-Disposition', `attachment; filename="kubeconfig-${target.email}.yaml"`);
  res.setHeader('Content-Type', 'application/yaml');
  res.send(kubeconfig);
}));

router.get('/api/rbac/users/:userId/certificate', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { context } = req.query;
  if (!context) return res.status(400).json({ error: 'context required' });
  if (!requireMonitoredContext(context, res)) return;
  const clusterName = _clusterNameForContext(context);

  const target = await User.findById(req.params.userId).select('email').lean();
  if (!target) return res.status(404).json({ error: 'User not found' });

  const kubeconfig = await certIssuer.getStoredKubeconfig(req.params.userId, clusterName);
  res.setHeader('Content-Disposition', `attachment; filename="kubeconfig-${target.email}.yaml"`);
  res.setHeader('Content-Type', 'application/yaml');
  res.send(kubeconfig);
}));

router.delete('/api/rbac/users/:userId/certificate', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { context } = req.query;
  if (!context) return res.status(400).json({ error: 'context required' });
  if (!requireMonitoredContext(context, res)) return;
  const clusterName = _clusterNameForContext(context);

  const target = await User.findById(req.params.userId).select('email').lean();
  if (!target) return res.status(404).json({ error: 'User not found' });

  const result = await certIssuer.revokeCertificate(req.params.userId, clusterName);

  RbacAuditLog.create({
    userId: req.user.id, userEmail: req.user.email,
    action: 'delete', kind: 'UserCertificate', name: target.email,
    context, timestamp: new Date(),
  }).catch(e => console.error('[RBAC Audit]', e.message));

  res.json(result);
}));

module.exports = router;
