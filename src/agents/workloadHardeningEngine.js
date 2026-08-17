'use strict';

// Scans Deployment/StatefulSet/DaemonSet pod templates for container-hardening
// gaps and reports them as standing SecurityFinding documents — same shape as
// rbacPostureEngine.js: feature-flagged, cycle-throttled, fire-and-forget,
// notify-only. Never touches the pod/node remediation pipeline.
//
// Scans controller pod *templates* rather than live Pods so a finding's identity
// (findingKey) stays stable across restarts — a live Pod's name changes every
// time its controller recreates it, which would otherwise make every restart
// look like the old finding vanished and a new one appeared.

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

const SCAN_INTERVAL_CYCLES = parseInt(process.env.WORKLOAD_HARDENING_INTERVAL_CYCLES ?? '10', 10);

// System-managed namespaces produce a lot of noise (CNI/kube-proxy DaemonSets
// legitimately need host access) and aren't what an operator is auditing for —
// same exclusion PoliciesPage.jsx already applies to its Pod Security section.
const SKIP_NAMESPACES = new Set(['kube-system', 'kube-public', 'kube-node-lease']);

const UNPINNED_IMAGE_RE = /:latest$/;
function _hasNoTag(image) {
  // "repo/image" with no ":" at all defaults to :latest just as much as an explicit one.
  // A registry host with a port (e.g. "registry:5000/image") has a ':' that isn't a tag
  // separator, so only check for ':' after the last '/'.
  const afterSlash = image.slice(image.lastIndexOf('/') + 1);
  return !afterSlash.includes(':');
}

class WorkloadHardeningEngine {
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
      console.log('[WORKLOAD-HARDENING] Previous scan still running — skipping');
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
        console.log(`[WORKLOAD-HARDENING] ${cluster}: ${newCount} new finding(s), ${findings.length} total open`);
        const notifEngine = _getNotifEngine();
        if (notifEngine) {
          notifEngine.emit({
            severity: 'WARNING',
            category: 'Security Posture',
            title:    `${newCount} new workload hardening finding(s) on ${cluster}`,
            message:  `Workload hardening scan found ${newCount} new issue(s) (${findings.length} currently open) — review in Hardening.`,
            metadata: { cluster, kind: 'WorkloadHardening', newCount, openCount: findings.length },
          }).catch(() => {});
        }
      }
      return { scanned: true, newCount, openCount: findings.length };
    } catch (err) {
      console.warn(`[WORKLOAD-HARDENING] ${cluster}: scan failed (non-blocking): ${err.message}`);
      return { scanned: false, reason: err.message };
    } finally {
      this._running = false;
    }
  }
}

// ── Detection rules (deterministic, no LLM) ───────────────────────────────────

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

  if (podSpec.hostNetwork === true) {
    findings.push({
      namespace: owner.namespace,
      resource:  { kind: owner.ownerKind, name: owner.name, namespace: owner.namespace },
      findingKey: `${resourceTag}:hostNetwork`,
      severity: 'high',
      description: `${owner.ownerKind} "${owner.name}" (ns: ${owner.namespace}) sets hostNetwork: true — its pods share the node's network namespace, exposing host-level network interfaces.`,
      cisControl: 'NSA/CISA Kubernetes Hardening Guidance — Host Namespace Sharing; Pod Security Standards — Restricted',
    });
  }
  if (podSpec.hostPID === true) {
    findings.push({
      namespace: owner.namespace,
      resource:  { kind: owner.ownerKind, name: owner.name, namespace: owner.namespace },
      findingKey: `${resourceTag}:hostPID`,
      severity: 'high',
      description: `${owner.ownerKind} "${owner.name}" (ns: ${owner.namespace}) sets hostPID: true — its containers can see and signal every process on the host.`,
      cisControl: 'NSA/CISA Kubernetes Hardening Guidance — Host Namespace Sharing; Pod Security Standards — Restricted',
    });
  }
  const hostPathVolumes = (podSpec.volumes ?? []).filter(v => v.hostPath);
  if (hostPathVolumes.length > 0) {
    findings.push({
      namespace: owner.namespace,
      resource:  { kind: owner.ownerKind, name: owner.name, namespace: owner.namespace },
      findingKey: `${resourceTag}:hostPath`,
      severity: 'high',
      description: `${owner.ownerKind} "${owner.name}" (ns: ${owner.namespace}) mounts hostPath volume(s) (${hostPathVolumes.map(v => v.hostPath.path).join(', ')}) — direct access to the node's filesystem.`,
      cisControl: 'NSA/CISA Kubernetes Hardening Guidance — Host Filesystem Access',
    });
  }

  const podRunAsNonRoot = podSpec.securityContext?.runAsNonRoot === true || (podSpec.securityContext?.runAsUser ?? 0) > 0;

  for (const container of podSpec.containers ?? []) {
    const sc = container.securityContext ?? {};
    const containerTag = `${resourceTag}:${container.name}`;

    if (sc.privileged === true) {
      findings.push({
        namespace: owner.namespace,
        resource:  { kind: owner.ownerKind, name: owner.name, namespace: owner.namespace },
        findingKey: `${containerTag}:privileged`,
        severity: 'critical',
        description: `Container "${container.name}" in ${owner.ownerKind} "${owner.name}" (ns: ${owner.namespace}) runs privileged: true — full access to all host devices, equivalent to root on the node.`,
        cisControl: 'Pod Security Standards — Restricted (privileged forbidden); CIS Kubernetes Benchmark §5.2',
      });
    }

    if (sc.allowPrivilegeEscalation !== false) {
      findings.push({
        namespace: owner.namespace,
        resource:  { kind: owner.ownerKind, name: owner.name, namespace: owner.namespace },
        findingKey: `${containerTag}:allowPrivilegeEscalation`,
        severity: 'medium',
        description: `Container "${container.name}" in ${owner.ownerKind} "${owner.name}" (ns: ${owner.namespace}) does not set allowPrivilegeEscalation: false — a process inside it can gain more privileges than its parent.`,
        cisControl: 'Pod Security Standards — Restricted; CIS Kubernetes Benchmark §5.2',
      });
    }

    const containerRunAsNonRoot = sc.runAsNonRoot === true || (sc.runAsUser ?? 0) > 0;
    if (!podRunAsNonRoot && !containerRunAsNonRoot) {
      findings.push({
        namespace: owner.namespace,
        resource:  { kind: owner.ownerKind, name: owner.name, namespace: owner.namespace },
        findingKey: `${containerTag}:runAsRoot`,
        severity: 'medium',
        description: `Container "${container.name}" in ${owner.ownerKind} "${owner.name}" (ns: ${owner.namespace}) has no runAsNonRoot/runAsUser set at pod or container level — will run as root (UID 0) unless the image itself defaults otherwise.`,
        cisControl: 'Pod Security Standards — Restricted (runAsNonRoot); CIS Kubernetes Benchmark §5.2',
      });
    }

    if (sc.readOnlyRootFilesystem !== true) {
      findings.push({
        namespace: owner.namespace,
        resource:  { kind: owner.ownerKind, name: owner.name, namespace: owner.namespace },
        findingKey: `${containerTag}:writableRootFS`,
        severity: 'low',
        description: `Container "${container.name}" in ${owner.ownerKind} "${owner.name}" (ns: ${owner.namespace}) has a writable root filesystem — set readOnlyRootFilesystem: true unless the container needs to write outside a mounted volume.`,
        cisControl: 'Pod Security Standards — Restricted',
      });
    }

    const limits = container.resources?.limits ?? {};
    if (!limits.cpu || !limits.memory) {
      findings.push({
        namespace: owner.namespace,
        resource:  { kind: owner.ownerKind, name: owner.name, namespace: owner.namespace },
        findingKey: `${containerTag}:missingLimits`,
        severity: 'medium',
        description: `Container "${container.name}" in ${owner.ownerKind} "${owner.name}" (ns: ${owner.namespace}) is missing ${!limits.cpu && !limits.memory ? 'CPU and memory' : !limits.cpu ? 'a CPU' : 'a memory'} limit — an unbounded container can starve or OOM its node.`,
        cisControl: 'NSA/CISA Kubernetes Hardening Guidance — Resource Management',
      });
    }

    const image = container.image ?? '';
    if (UNPINNED_IMAGE_RE.test(image) || _hasNoTag(image)) {
      findings.push({
        namespace: owner.namespace,
        resource:  { kind: owner.ownerKind, name: owner.name, namespace: owner.namespace },
        findingKey: `${containerTag}:unpinnedImage`,
        severity: 'low',
        description: `Container "${container.name}" in ${owner.ownerKind} "${owner.name}" (ns: ${owner.namespace}) uses image "${image}" without a pinned version tag — deployments become non-reproducible and can silently pull a different image on restart.`,
        cisControl: 'NSA/CISA Kubernetes Hardening Guidance — Image Provenance',
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
    const existing = await _SecurityFinding.findOne({ cluster, kind: 'WorkloadHardening', findingKey: f.findingKey });
    if (existing) {
      existing.lastSeenAt = now;
      existing.severity   = f.severity;
      existing.description = f.description;
      if (existing.status === 'resolved') existing.status = 'open';
      await existing.save();
    } else {
      await _SecurityFinding.create({
        cluster, kind: 'WorkloadHardening',
        namespace: f.namespace, findingKey: f.findingKey, severity: f.severity,
        resource: f.resource, description: f.description, cisControl: f.cisControl,
        detectedAt: now, lastSeenAt: now, status: 'open',
      });
      newCount++;
    }
  }

  await _SecurityFinding.updateMany(
    { cluster, kind: 'WorkloadHardening', status: 'open', findingKey: { $nin: [...seenKeys] } },
    { $set: { status: 'resolved' } }
  );

  return newCount;
}

module.exports = new WorkloadHardeningEngine();
