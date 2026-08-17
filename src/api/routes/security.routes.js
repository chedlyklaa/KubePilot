'use strict';
const express = require('express');
const { SecurityFinding } = require('../../db/models');
const { getClusters } = require('../../config/clusterConfig');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const escalationStore = require('../escalationStore');

const router = express.Router();

// Findings are admin-only, same reasoning as /api/policies/overview — posture
// data is sensitive and some orgs restrict it to platform/security teams.
router.use('/api/security', requireAuth, requireAdmin);

// Detector engines, keyed by the `kind` they own — used by the rescan endpoint
// to dispatch to the right one. Only RbacPosture exists so far; future milestones
// (Workload Hardening, Network Exposure, Secrets Hygiene) register here too.
const ENGINES_BY_KIND = {
  RbacPosture:       () => require('../../agents/rbacPostureEngine'),
  WorkloadHardening: () => require('../../agents/workloadHardeningEngine'),
  NetworkExposure:   () => require('../../agents/networkExposureEngine'),
  SecretsHygiene:    () => require('../../agents/secretsHygieneEngine'),
};

function _contextForCluster(name) {
  return getClusters().find(c => c.name === name)?.context ?? null;
}

// GET /api/security/overview?cluster=NAME — open-finding counts by kind and severity
router.get('/api/security/overview', asyncHandler(async (req, res) => {
  const { cluster } = req.query;
  if (!cluster) return res.status(400).json({ error: 'cluster is required' });

  const open = await SecurityFinding.find({ cluster, status: 'open' }).select('kind severity').lean();
  const byKind = {};
  const bySeverity = { low: 0, medium: 0, high: 0, critical: 0 };
  for (const f of open) {
    byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
    if (bySeverity[f.severity] != null) bySeverity[f.severity]++;
  }
  res.json({ cluster, total: open.length, byKind, bySeverity });
}));

// GET /api/security/findings?cluster=NAME&kind=RbacPosture&status=open
router.get('/api/security/findings', asyncHandler(async (req, res) => {
  const { cluster, kind, status = 'open' } = req.query;
  if (!cluster) return res.status(400).json({ error: 'cluster is required' });

  const filter = { cluster };
  if (kind)   filter.kind = kind;
  if (status !== '_all') filter.status = status;

  const severityRank = { critical: 3, high: 2, medium: 1, low: 0 };
  const findings = await SecurityFinding.find(filter).lean();
  findings.sort((a, b) =>
    (severityRank[b.severity] ?? 0) - (severityRank[a.severity] ?? 0) ||
    new Date(b.detectedAt) - new Date(a.detectedAt)
  );
  res.json(findings);
}));

// POST /api/security/findings/:id/accept  { reason }
// Marks a finding as an accepted risk — mirrors silenceStore's reason/createdBy
// shape, but permanent (no expiry) since this is a deliberate sign-off, not a
// temporary mute. Does not touch the cluster in any way.
router.post('/api/security/findings/:id/accept', asyncHandler(async (req, res) => {
  const { reason } = req.body;
  const finding = await SecurityFinding.findById(req.params.id);
  if (!finding) return res.status(404).json({ error: 'Finding not found' });

  finding.status = 'accepted';
  finding.acceptedBy = { userId: req.user.id, name: req.user.name, email: req.user.email };
  finding.acceptedReason = reason ?? null;
  await finding.save();

  res.json(finding);
}));

// POST /api/security/findings/:id/rescan
// Runs the owning engine's scan immediately instead of waiting for its cycle
// throttle — useful right after applying a fix, to confirm the finding is gone.
router.post('/api/security/findings/:id/rescan', asyncHandler(async (req, res) => {
  const finding = await SecurityFinding.findById(req.params.id);
  if (!finding) return res.status(404).json({ error: 'Finding not found' });

  const getEngine = ENGINES_BY_KIND[finding.kind];
  if (!getEngine) return res.status(400).json({ error: `No detector registered for kind "${finding.kind}"` });

  const context = _contextForCluster(finding.cluster);
  if (!context) return res.status(404).json({ error: `Cluster "${finding.cluster}" is not monitored` });

  const result = await getEngine().rescanNow({ cluster: finding.cluster, context });
  res.json(result);
}));

// POST /api/security/findings/:id/escalate
// Pushes a finding into the same urgent Escalations queue used by unresolved
// pod/node incidents — for the rare finding that needs someone paged now rather
// than quietly sitting on a findings table.
router.post('/api/security/findings/:id/escalate', asyncHandler(async (req, res) => {
  const finding = await SecurityFinding.findById(req.params.id);
  if (!finding) return res.status(404).json({ error: 'Finding not found' });

  const issueKey = `security:${finding.kind}:${finding._id}`;
  const syntheticIssue = {
    type:        `Security/${finding.kind}`,
    namespace:   finding.namespace ?? 'default',
    clusterName: finding.cluster,
    podName:     null,
  };
  const id = await escalationStore.escalate(issueKey, syntheticIssue, [{
    attempt: 1, action: 'security-finding', outcome: 'blocked', note: finding.description, at: new Date(),
  }]);

  res.json({ escalationId: id });
}));

function _csvField(value) {
  const s = value == null ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// GET /api/security/report?cluster=NAME (optional — omit for a fleet-wide export)
// CSV only for now — PDF is a stretch goal, not built.
router.get('/api/security/report', asyncHandler(async (req, res) => {
  const { cluster } = req.query;
  const filter = cluster ? { cluster } : {};
  const findings = await SecurityFinding.find(filter).sort({ cluster: 1, kind: 1, severity: -1 }).lean();

  const header = ['cluster', 'kind', 'namespace', 'resource', 'severity', 'description', 'cisControl', 'status'];
  const rows = findings.map(f => [
    f.cluster, f.kind, f.namespace ?? '', `${f.resource?.kind ?? ''}/${f.resource?.name ?? ''}`,
    f.severity, f.description, f.cisControl ?? '', f.status,
  ].map(_csvField).join(','));
  const csv = [header.join(','), ...rows].join('\n');

  res.setHeader('Content-Disposition', `attachment; filename="security-findings${cluster ? `-${cluster}` : ''}.csv"`);
  res.setHeader('Content-Type', 'text/csv');
  res.send(csv);
}));

module.exports = router;
