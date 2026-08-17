'use strict';

// Scans live RBAC (ClusterRoles, Roles, ClusterRoleBindings, RoleBindings,
// ServiceAccounts) for over-permissioning and reports the result as standing
// SecurityFinding documents — never touches the pod/node remediation pipeline
// (no PolicyEngine, no GuardianAgent, no episodic memory). Same shape as
// rbacDriftEngine.js: feature-flagged, cycle-throttled, fire-and-forget,
// notify-only.

let _SecurityFinding = null;
let _notifEngine     = null;

function _initModels() {
  if (_SecurityFinding) return;
  try { ({ SecurityFinding: _SecurityFinding } = require('../db/models')); } catch { /* MongoDB unavailable */ }
}

function _getNotifEngine() {
  if (!_notifEngine) {
    try { _notifEngine = require('../services/notifications/engine'); } catch { /* not available */ }
  }
  return _notifEngine;
}

const SCAN_INTERVAL_CYCLES = parseInt(process.env.RBAC_POSTURE_INTERVAL_CYCLES ?? '10', 10);

const DANGEROUS_ROLE_NAMES = new Set(['cluster-admin', 'admin', 'edit']);
const KUBEPILOT_MANAGED_LABEL = 'app.kubernetes.io/managed-by';

function _isManagedByKubepilot(binding) {
  return binding.metadata?.labels?.[KUBEPILOT_MANAGED_LABEL] === 'kubepilot';
}

function _isDangerousRoleName(name) {
  return DANGEROUS_ROLE_NAMES.has(name) || (name ?? '').includes('cluster-admin');
}

// A rule is a "full wildcard" if both its verbs and resources include '*'
// (e.g. the built-in cluster-admin rule) — strictly more dangerous than a
// narrower wildcard on just one axis (e.g. verbs:['get','list'], resources:['*']).
function _wildcardSeverity(rules) {
  let sawResourceWildcard = false;
  let sawVerbWildcard     = false;
  for (const r of rules ?? []) {
    const verbs     = r.verbs     ?? [];
    const resources = r.resources ?? [];
    if (verbs.includes('*'))     sawVerbWildcard     = true;
    if (resources.includes('*')) sawResourceWildcard = true;
  }
  if (sawVerbWildcard && sawResourceWildcard) return 'critical';
  if (sawVerbWildcard || sawResourceWildcard) return 'high';
  return null;
}

function _grantsSecretsAccess(rules) {
  return (rules ?? []).some(r =>
    (r.resources ?? []).some(x => x === 'secrets' || x === '*') &&
    (r.verbs ?? []).some(v => ['get', 'list', 'watch', '*'].includes(v))
  );
}

function _grantsPodExec(rules) {
  return (rules ?? []).some(r =>
    (r.resources ?? []).some(x => x === 'pods/exec' || x === '*') &&
    (r.verbs ?? []).some(v => ['create', '*'].includes(v))
  );
}

class RbacPostureEngine {
  constructor() {
    this._cycleCount = 0;
    this._running    = false;
  }

  // Called from ClusterAgent.run() — non-blocking, fire-and-forget, feature-flagged,
  // throttled to once every SCAN_INTERVAL_CYCLES cluster cycles.
  async check({ cluster, context }) {
    this._cycleCount++;
    if (this._cycleCount % SCAN_INTERVAL_CYCLES !== 0) return;
    await this.rescanNow({ cluster, context });
  }

  // Runs the scan immediately, bypassing the cycle throttle — used by the
  // "Re-scan now" button (POST /api/security/findings/:id/rescan) as well as by
  // check() above once its throttle interval has elapsed.
  async rescanNow({ cluster, context }) {
    _initModels();
    if (!_SecurityFinding) return { scanned: false, reason: 'MongoDB unavailable' };

    if (this._running) {
      console.log('[RBAC-POSTURE] Previous scan still running — skipping');
      return { scanned: false, reason: 'already running' };
    }
    this._running = true;

    try {
      const kubectl = require('../tools/kubectl');
      const [clusterRoles, roles, clusterRoleBindings, roleBindings, serviceAccounts] = await Promise.all([
        kubectl.getClusterRoles(context),
        kubectl.getRoles('*', context),
        kubectl.getClusterRoleBindings(context),
        kubectl.getRoleBindings('*', context),
        kubectl.getServiceAccounts('*', context),
      ]);

      const findings = [
        ..._scanBindings(clusterRoles, roles, clusterRoleBindings, roleBindings),
        ..._scanDefaultServiceAccounts(serviceAccounts),
      ];

      const newCount = await _reconcile(cluster, findings);
      if (newCount > 0) {
        console.log(`[RBAC-POSTURE] ${cluster}: ${newCount} new finding(s), ${findings.length} total open`);
        const notifEngine = _getNotifEngine();
        if (notifEngine) {
          notifEngine.emit({
            severity: 'WARNING',
            category: 'Security Posture',
            title:    `${newCount} new RBAC finding(s) on ${cluster}`,
            message:  `RBAC posture scan found ${newCount} new issue(s) (${findings.length} currently open) — review in RBAC → Findings.`,
            metadata: { cluster, kind: 'RbacPosture', newCount, openCount: findings.length },
          }).catch(() => {});
        }
      }
      return { scanned: true, newCount, openCount: findings.length };
    } catch (err) {
      console.warn(`[RBAC-POSTURE] ${cluster}: scan failed (non-blocking): ${err.message}`);
      return { scanned: false, reason: err.message };
    } finally {
      this._running = false;
    }
  }
}

// ── Detection rules (deterministic, no LLM) ───────────────────────────────────

function _scanBindings(clusterRoles, roles, clusterRoleBindings, roleBindings) {
  const findings = [];

  // Build a roleKey → wildcard-severity lookup so bindings can be judged by what
  // their role actually grants, not just its name. system: roles are excluded —
  // they're built-in Kubernetes internals, not something an operator configured.
  const wildcardByRole = new Map(); // `${kind}/${name}` -> severity|null
  for (const cr of clusterRoles ?? []) {
    if (cr.metadata?.name?.startsWith('system:')) continue;
    wildcardByRole.set(`ClusterRole/${cr.metadata.name}`, _wildcardSeverity(cr.rules));
  }
  for (const r of roles ?? []) {
    if (r.metadata?.name?.startsWith('system:')) continue;
    wildcardByRole.set(`Role/${r.metadata.namespace}/${r.metadata.name}`, _wildcardSeverity(r.rules));
  }

  const secretsAccessByRole = new Map();
  const podExecByRole       = new Map();
  for (const cr of clusterRoles ?? []) {
    secretsAccessByRole.set(`ClusterRole/${cr.metadata.name}`, _grantsSecretsAccess(cr.rules));
    podExecByRole.set(`ClusterRole/${cr.metadata.name}`, _grantsPodExec(cr.rules));
  }
  for (const r of roles ?? []) {
    secretsAccessByRole.set(`Role/${r.metadata.namespace}/${r.metadata.name}`, _grantsSecretsAccess(r.rules));
    podExecByRole.set(`Role/${r.metadata.namespace}/${r.metadata.name}`, _grantsPodExec(r.rules));
  }

  function _evaluate(binding, scope, namespace) {
    if (_isManagedByKubepilot(binding)) return; // expected — kubepilot's own kp-* sync bindings

    const roleName = binding.roleRef?.name;
    const roleKind = binding.roleRef?.kind;
    const roleKey  = roleKind === 'ClusterRole' ? `ClusterRole/${roleName}` : `Role/${namespace}/${roleName}`;
    const bindingName = binding.metadata?.name;

    const dangerousName   = _isDangerousRoleName(roleName);
    const wildcardSev      = wildcardByRole.get(roleKey);
    const grantsSecrets    = secretsAccessByRole.get(roleKey);
    const grantsExec       = podExecByRole.get(roleKey);

    if (dangerousName || wildcardSev) {
      const severity = roleName === 'cluster-admin' ? 'critical' : (wildcardSev ?? 'high');
      findings.push({
        namespace: scope === 'cluster' ? null : namespace,
        resource:  { kind: scope === 'cluster' ? 'ClusterRoleBinding' : 'RoleBinding', name: bindingName, namespace },
        findingKey: `${scope === 'cluster' ? 'ClusterRoleBinding' : 'RoleBinding'}/${namespace ?? 'cluster'}/${bindingName}:overpermissioned`,
        severity,
        description: `${scope === 'cluster' ? 'ClusterRoleBinding' : 'RoleBinding'} "${bindingName}" grants ${roleKind} "${roleName}"` +
          (dangerousName ? ' — a built-in high-privilege role' : ' — which contains a wildcard rule (verbs or resources: "*")') +
          ` to ${(binding.subjects ?? []).map(s => `${s.kind}:${s.name}`).join(', ') || 'no subjects'}.`,
        cisControl: 'CIS Kubernetes Benchmark 5.1.1 / 5.1.3',
      });
    }

    for (const subject of binding.subjects ?? []) {
      if (subject.kind !== 'ServiceAccount') continue;
      if (grantsSecrets) {
        findings.push({
          namespace: subject.namespace ?? namespace,
          resource:  { kind: 'ServiceAccount', name: subject.name, namespace: subject.namespace ?? namespace },
          findingKey: `ServiceAccount/${subject.namespace ?? namespace}/${subject.name}:secrets-access:${roleKey}`,
          severity: 'high',
          description: `ServiceAccount "${subject.name}" (ns: ${subject.namespace ?? namespace}) can read Secrets via ${roleKind} "${roleName}" (bound by "${bindingName}").`,
          cisControl: 'CIS Kubernetes Benchmark 5.1.5',
        });
      }
      if (grantsExec) {
        findings.push({
          namespace: subject.namespace ?? namespace,
          resource:  { kind: 'ServiceAccount', name: subject.name, namespace: subject.namespace ?? namespace },
          findingKey: `ServiceAccount/${subject.namespace ?? namespace}/${subject.name}:pod-exec:${roleKey}`,
          severity: 'high',
          description: `ServiceAccount "${subject.name}" (ns: ${subject.namespace ?? namespace}) can exec into pods via ${roleKind} "${roleName}" (bound by "${bindingName}") — a common privilege-escalation / lateral-movement path.`,
          cisControl: 'MITRE ATT&CK for Containers — T1609 (Container Administration Command)',
        });
      }
    }
  }

  for (const crb of clusterRoleBindings ?? []) _evaluate(crb, 'cluster', null);
  for (const rb of roleBindings ?? [])         _evaluate(rb, 'namespace', rb.metadata?.namespace);

  return findings;
}

function _scanDefaultServiceAccounts(serviceAccounts) {
  const findings = [];
  for (const sa of serviceAccounts ?? []) {
    if (sa.metadata?.name !== 'default') continue;
    if (sa.automountServiceAccountToken === false) continue; // already hardened
    const ns = sa.metadata?.namespace;
    findings.push({
      namespace: ns,
      resource:  { kind: 'ServiceAccount', name: 'default', namespace: ns },
      findingKey: `ServiceAccount/${ns}/default:automount-token`,
      severity: 'low',
      description: `The default ServiceAccount in namespace "${ns}" automounts its API token into every pod that doesn't specify its own — set automountServiceAccountToken: false unless pods in this namespace need API access.`,
      cisControl: 'CIS Kubernetes Benchmark 5.1.6',
    });
  }
  return findings;
}

// ── Upsert findings, resolve ones no longer seen ─────────────────────────────

async function _reconcile(cluster, detected) {
  const now = new Date();
  const seenKeys = new Set();
  let newCount = 0;

  for (const f of detected) {
    seenKeys.add(f.findingKey);
    const existing = await _SecurityFinding.findOne({ cluster, kind: 'RbacPosture', findingKey: f.findingKey });
    if (existing) {
      existing.lastSeenAt = now;
      existing.severity   = f.severity;
      existing.description = f.description;
      if (existing.status === 'resolved') existing.status = 'open'; // reappeared after being fixed
      await existing.save();
    } else {
      await _SecurityFinding.create({
        cluster, kind: 'RbacPosture',
        namespace: f.namespace, findingKey: f.findingKey, severity: f.severity,
        resource: f.resource, description: f.description, cisControl: f.cisControl,
        detectedAt: now, lastSeenAt: now, status: 'open',
      });
      newCount++;
    }
  }

  // Findings that were open but weren't detected this scan look fixed — but never
  // silently override a human's 'accepted'/'silenced' decision.
  await _SecurityFinding.updateMany(
    { cluster, kind: 'RbacPosture', status: 'open', findingKey: { $nin: [...seenKeys] } },
    { $set: { status: 'resolved' } }
  );

  return newCount;
}

module.exports = new RbacPostureEngine();
