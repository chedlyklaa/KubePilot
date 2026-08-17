'use strict';

// Scans Deployment/StatefulSet/DaemonSet pod templates for risky Secret *usage
// patterns* and reports them as standing SecurityFinding documents — same shape
// as workloadHardeningEngine.js: feature-flagged, cycle-throttled,
// fire-and-forget, notify-only. Never touches the pod/node remediation pipeline.
//
// Scoped deliberately to what's readable from pod specs alone (env/envFrom/
// volumes) — everything here needs no permission beyond what KubePilot already
// has (Deployments/StatefulSets/DaemonSets are already read for Workload
// Hardening). It never calls `kubectl get secrets` and never reads a Secret's
// values — only whether/how a pod *references* one. The "unrotated secret" age
// check from the original plan needs a new getSecretsMetadata() kubectl read and
// is deliberately deferred pending sign-off on that broader permission.

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

const SCAN_INTERVAL_CYCLES = parseInt(process.env.SECRETS_HYGIENE_INTERVAL_CYCLES ?? '10', 10);

// Same exclusion the other posture engines already apply.
const SKIP_NAMESPACES = new Set(['kube-system', 'kube-public', 'kube-node-lease']);

class SecretsHygieneEngine {
  constructor() {
    this._cycleCount = 0;
    this._running    = false;
  }

  async check({ cluster, context }) {
    this._cycleCount++;
    if (this._cycleCount % SCAN_INTERVAL_CYCLES !== 0) return;
    await this.rescanNow({ cluster, context });
  }

  // Runs the scan immediately, bypassing the cycle throttle — used by the
  // "Re-scan now" button as well as by check() once its interval has elapsed.
  async rescanNow({ cluster, context }) {
    _initModels();
    if (!_SecurityFinding) return { scanned: false, reason: 'MongoDB unavailable' };

    if (this._running) {
      console.log('[SECRETS-HYGIENE] Previous scan still running — skipping');
      return { scanned: false, reason: 'already running' };
    }
    this._running = true;

    try {
      const kubectl = require('../tools/kubectl');
      const [deployments, statefulSets, daemonSets] = await Promise.all([
        kubectl.getDeploymentsFull('*', context),
        kubectl.getStatefulSetsFull('*', context),
        kubectl.getDaemonSetsFull('*', context),
      ]);

      const findings = [
        ..._scanWorkloads(deployments, 'Deployment'),
        ..._scanWorkloads(statefulSets, 'StatefulSet'),
        ..._scanWorkloads(daemonSets, 'DaemonSet'),
      ];

      const newCount = await _reconcile(cluster, findings);
      if (newCount > 0) {
        console.log(`[SECRETS-HYGIENE] ${cluster}: ${newCount} new finding(s), ${findings.length} total open`);
        const notifEngine = _getNotifEngine();
        if (notifEngine) {
          notifEngine.emit({
            severity: 'WARNING',
            category: 'Security Posture',
            title:    `${newCount} new secrets hygiene finding(s) on ${cluster}`,
            message:  `Secrets hygiene scan found ${newCount} new issue(s) (${findings.length} currently open) — review in Secrets.`,
            metadata: { cluster, kind: 'SecretsHygiene', newCount, openCount: findings.length },
          }).catch(() => {});
        }
      }
      return { scanned: true, newCount, openCount: findings.length };
    } catch (err) {
      console.warn(`[SECRETS-HYGIENE] ${cluster}: scan failed (non-blocking): ${err.message}`);
      return { scanned: false, reason: err.message };
    } finally {
      this._running = false;
    }
  }
}

// ── Detection rules (deterministic, no LLM, no Secret reads) ─────────────────

function _scanWorkloads(items, ownerKind) {
  const findings = [];
  for (const item of items ?? []) {
    const namespace = item.metadata?.namespace;
    const name       = item.metadata?.name;
    if (SKIP_NAMESPACES.has(namespace)) continue;

    const podSpec = item.spec?.template?.spec;
    if (!podSpec) continue;

    findings.push(..._evaluatePodSpec(podSpec, { ownerKind, name, namespace }));
  }
  return findings;
}

function _evaluatePodSpec(podSpec, owner) {
  const findings = [];
  const resourceTag = `${owner.ownerKind}/${owner.namespace}/${owner.name}`;

  // Secret volumes with no `items:` list mount every key in the Secret, even if
  // the pod only ever reads one of them — narrowing via `items:` limits blast
  // radius if the container is ever compromised.
  for (const vol of podSpec.volumes ?? []) {
    if (!vol.secret) continue;
    if (Array.isArray(vol.secret.items) && vol.secret.items.length > 0) continue; // already narrowed
    findings.push({
      namespace: owner.namespace,
      resource:  { kind: owner.ownerKind, name: owner.name, namespace: owner.namespace },
      findingKey: `${resourceTag}:secret-volume-unscoped:${vol.secret.secretName}`,
      severity: 'low',
      description: `${owner.ownerKind} "${owner.name}" (ns: ${owner.namespace}) mounts Secret "${vol.secret.secretName}" as volume "${vol.name}" with no items: list — every key in the Secret is exposed to the pod, not just the ones it needs.`,
      cisControl: 'CIS Kubernetes Benchmark §5.4 (Secrets Management)',
    });
  }

  for (const container of podSpec.containers ?? []) {
    const containerTag = `${resourceTag}:${container.name}`;

    // envFrom.secretRef dumps every key in the Secret as an environment variable.
    for (const ef of container.envFrom ?? []) {
      if (!ef.secretRef?.name) continue;
      findings.push({
        namespace: owner.namespace,
        resource:  { kind: owner.ownerKind, name: owner.name, namespace: owner.namespace },
        findingKey: `${containerTag}:envFrom-secret:${ef.secretRef.name}`,
        severity: 'medium',
        description: `Container "${container.name}" in ${owner.ownerKind} "${owner.name}" (ns: ${owner.namespace}) loads Secret "${ef.secretRef.name}" entirely via envFrom — every key becomes an environment variable, which is easy to accidentally leak via logs, error reporters, or child processes.`,
        cisControl: 'CIS Kubernetes Benchmark §5.4 (Secrets Management)',
      });
    }

    // env[].valueFrom.secretKeyRef selects one key but still as an env var.
    for (const e of container.env ?? []) {
      const ref = e.valueFrom?.secretKeyRef;
      if (!ref?.name) continue;
      findings.push({
        namespace: owner.namespace,
        resource:  { kind: owner.ownerKind, name: owner.name, namespace: owner.namespace },
        findingKey: `${containerTag}:env-secret:${ref.name}:${ref.key}`,
        severity: 'low',
        description: `Container "${container.name}" in ${owner.ownerKind} "${owner.name}" (ns: ${owner.namespace}) exposes Secret "${ref.name}" key "${ref.key}" as environment variable "${e.name}" — prefer mounting it as a file, since env vars are visible in "kubectl describe pod", crash dumps, and /proc/<pid>/environ.`,
        cisControl: 'CIS Kubernetes Benchmark §5.4 (Secrets Management)',
      });
    }
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
    const existing = await _SecurityFinding.findOne({ cluster, kind: 'SecretsHygiene', findingKey: f.findingKey });
    if (existing) {
      existing.lastSeenAt = now;
      existing.severity   = f.severity;
      existing.description = f.description;
      if (existing.status === 'resolved') existing.status = 'open';
      await existing.save();
    } else {
      await _SecurityFinding.create({
        cluster, kind: 'SecretsHygiene',
        namespace: f.namespace, findingKey: f.findingKey, severity: f.severity,
        resource: f.resource, description: f.description, cisControl: f.cisControl,
        detectedAt: now, lastSeenAt: now, status: 'open',
      });
      newCount++;
    }
  }

  await _SecurityFinding.updateMany(
    { cluster, kind: 'SecretsHygiene', status: 'open', findingKey: { $nin: [...seenKeys] } },
    { $set: { status: 'resolved' } }
  );

  return newCount;
}

module.exports = new SecretsHygieneEngine();
