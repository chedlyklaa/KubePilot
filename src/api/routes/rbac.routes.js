'use strict';
const express = require('express');
const yaml = require('js-yaml');
const kubectl = require('../../tools/kubectl');
const { RbacAuditLog, User } = require('../../db/models');
const { getClusters } = require('../../config/clusterConfig');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const rbacSync = require('../../services/rbacSync');
const certIssuer = require('../../services/certIssuer');

const router = express.Router();

function isDangerous(roleName) {
  return ['cluster-admin', 'admin', 'edit'].includes(roleName) ||
    roleName.includes('cluster-admin');
}

// Context allow-list: only clusters configured in clusters.yaml can be targeted.
// All RBAC endpoints call requireMonitoredContext() before touching kubectl.
function requireMonitoredContext(context, res) {
  const monitored = new Set(getClusters().map(c => c.context));
  if (!monitored.has(context)) {
    res.status(403).json({ error: 'Context not in monitored clusters' });
    return false;
  }
  return true;
}

// GET /api/rbac/namespaces?context=CTX
router.get('/api/rbac/namespaces', requireAuth, asyncHandler(async (req, res) => {
  const { context } = req.query;
  if (!context) return res.status(400).json({ error: 'context required' });
  if (!requireMonitoredContext(context, res)) return;
  res.json(await kubectl.getNamespaces(context));
}));

// GET /api/rbac/overview?context=CTX&namespace=NS[&includeSystem=true]
// namespace=_all fetches across all namespaces (client filters)
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
  // Annotate bindings with server-computed dangerous flag so the client
  // doesn't need its own copy of the isDangerous logic.
  const markDangerous = arr => arr.map(b => ({ ...b, dangerous: isDangerous(b.roleRef?.name ?? '') }));
  // Strip system: ClusterRoles server-side; bypass with ?includeSystem=true
  const filteredClusterRoles = includeSystem === 'true'
    ? clusterRoles
    : clusterRoles.filter(r => !r.metadata.name.startsWith('system:'));
  res.json({
    roles, clusterRoles: filteredClusterRoles, serviceAccounts,
    roleBindings:        markDangerous(roleBindings),
    clusterRoleBindings: markDangerous(clusterRoleBindings),
  });
}));

// GET /api/rbac/audit?context=CTX&namespace=NS — flattened subject→role mapping
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

// POST /api/rbac/apply — apply one or more YAML documents (admin only)
router.post('/api/rbac/apply', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { yaml: yamlContent, context } = req.body;
  if (!yamlContent || !context)
    return res.status(400).json({ error: 'yaml and context required' });
  if (!requireMonitoredContext(context, res)) return;

  // Parse every document in the multi-doc YAML (--- separated)
  let docs;
  try {
    docs = yaml.loadAll(yamlContent).filter(d => d != null);
  } catch (e) {
    return res.status(400).json({ error: `Invalid YAML: ${e.message}` });
  }
  if (docs.length === 0)
    return res.status(400).json({ error: 'No documents found in YAML' });

  // Validate every document against the RBAC allowlist before touching the cluster
  for (const doc of docs) {
    const kind = doc?.kind;
    if (!kind || !RBAC_APPLY_KINDS.has(kind))
      return res.status(400).json({
        error: `Only RBAC resources are permitted. Got kind: ${kind ?? '(none)'}`,
        invalidDocument: { kind, name: doc?.metadata?.name },
      });
  }

  // Dry-run all documents together (same file = one kubectl call)
  let dryRunOutput;
  try {
    dryRunOutput = await kubectl.dryRunManifest(yamlContent, context);
  } catch (err) {
    return res.status(400).json({ error: 'Dry-run failed', detail: err.message });
  }

  // Apply all documents together
  const output = await kubectl.applyManifest(yamlContent, context);

  // Audit-log every document that was applied — fire-and-forget
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

// DELETE /api/rbac/resource — delete a RBAC resource (admin only)
router.delete('/api/rbac/resource', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { kind, name, namespace, context } = req.body;
  if (!kind || !name || !context)
    return res.status(400).json({ error: 'kind, name, context required' });
  if (!requireMonitoredContext(context, res)) return;
  const output = await kubectl.deleteRbacResource(kind, name, namespace, context);
  RbacAuditLog.create({ userId: req.user.id, userEmail: req.user.email, action: 'delete', kind, name, namespace, context, timestamp: new Date() }).catch(e => console.error('[RBAC Audit]', e.message));
  res.json({ output });
}));

// POST /api/rbac/sync-from-k8s — pull RoleBindings/ClusterRoleBindings from one
// cluster and reconcile them into system User.permissions (admin only; mutates
// other users' access, so it's audit-logged like apply/delete).
router.post('/api/rbac/sync-from-k8s', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { context } = req.body;
  if (!context) return res.status(400).json({ error: 'context required' });
  if (!requireMonitoredContext(context, res)) return;

  const result = await rbacSync.syncFromK8s(context);

  RbacAuditLog.create({
    userId: req.user.id, userEmail: req.user.email,
    action: 'apply', kind: 'UserPermissionsSync', name: `${result.updated.length} user(s)`,
    context, timestamp: new Date(),
  }).catch(e => console.error('[RBAC Audit]', e.message));

  res.json(result);
}));

// ── Per-user client certificate (direct kubectl access, outside the dashboard) ──
// Runs alongside the existing impersonation model (kubectl --as=email) rather than
// replacing it — this is an opt-in extra an admin issues for a specific user who
// wants their own kubeconfig. See services/certIssuer.js for the full flow.

function _clusterNameForContext(context) {
  return getClusters().find(c => c.context === context)?.name ?? null;
}

// POST /api/rbac/users/:userId/certificate  { context }
// Issues (or re-issues) a client cert for this user on this cluster and returns a
// ready-to-use kubeconfig. Re-issuing replaces the previously stored cert.
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

// GET /api/rbac/users/:userId/certificate?context=CTX
// Re-downloads a previously issued cert's kubeconfig without regenerating it.
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

// DELETE /api/rbac/users/:userId/certificate?context=CTX
// Removes the stored cert record. Note: this does NOT revoke the certificate's
// validity in K8s itself — Kubernetes' client-cert auth has no built-in revocation
// (no CRL/OCSP check by default), so an already-issued cert keeps working until it
// expires. Revoking real access means removing the user's RoleBindings (delete
// their permissions and re-run sync), not just this stored record.
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
