'use strict';

// Scans NetworkPolicies, Services, and Ingresses for network-exposure gaps and
// reports them as standing SecurityFinding documents — same shape as
// rbacPostureEngine.js / workloadHardeningEngine.js: feature-flagged,
// cycle-throttled, fire-and-forget, notify-only. Never touches the pod/node
// remediation pipeline.

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

const SCAN_INTERVAL_CYCLES = parseInt(process.env.NETWORK_EXPOSURE_INTERVAL_CYCLES ?? '10', 10);

// Same exclusion PoliciesPage.jsx and workloadHardeningEngine.js already apply —
// system namespaces aren't what an operator is auditing network exposure for.
const SKIP_NAMESPACES = new Set(['kube-system', 'kube-public', 'kube-node-lease']);

const EXPOSED_SERVICE_TYPES = new Set(['NodePort', 'LoadBalancer']);

class NetworkExposureEngine {
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
      console.log('[NETWORK-EXPOSURE] Previous scan still running — skipping');
      return { scanned: false, reason: 'already running' };
    }
    this._running = true;

    try {
      const kubectl = require('../tools/kubectl');
      const [pods, networkPolicies, services, ingresses] = await Promise.all([
        kubectl.getPods('*', context, true),
        kubectl.getNetworkPolicies('*', context),
        kubectl.getServices('*', context),
        kubectl.getIngresses('*', context),
      ]);

      const findings = [
        ..._scanNamespacesWithoutPolicy(pods, networkPolicies),
        ..._scanExposedServices(services),
        ..._scanIngressesWithoutTls(ingresses),
      ];

      const newCount = await _reconcile(cluster, findings);
      if (newCount > 0) {
        console.log(`[NETWORK-EXPOSURE] ${cluster}: ${newCount} new finding(s), ${findings.length} total open`);
        const notifEngine = _getNotifEngine();
        if (notifEngine) {
          notifEngine.emit({
            severity: 'WARNING',
            category: 'Security Posture',
            title:    `${newCount} new network exposure finding(s) on ${cluster}`,
            message:  `Network exposure scan found ${newCount} new issue(s) (${findings.length} currently open) — review in Network → Findings.`,
            metadata: { cluster, kind: 'NetworkExposure', newCount, openCount: findings.length },
          }).catch(() => {});
        }
      }
      return { scanned: true, newCount, openCount: findings.length };
    } catch (err) {
      console.warn(`[NETWORK-EXPOSURE] ${cluster}: scan failed (non-blocking): ${err.message}`);
      return { scanned: false, reason: err.message };
    } finally {
      this._running = false;
    }
  }
}

// ── Detection rules (deterministic, no LLM) ───────────────────────────────────

function _scanNamespacesWithoutPolicy(podsJson, networkPolicies) {
  const findings = [];

  const namespacesWithPods = new Set(
    (podsJson?.items ?? [])
      .map(p => p.metadata?.namespace)
      .filter(ns => ns && !SKIP_NAMESPACES.has(ns))
  );
  const namespacesWithPolicy = new Set(
    (networkPolicies ?? []).map(np => np.metadata?.namespace).filter(Boolean)
  );

  for (const ns of namespacesWithPods) {
    if (namespacesWithPolicy.has(ns)) continue;
    findings.push({
      namespace: ns,
      resource:  { kind: 'Namespace', name: ns, namespace: ns },
      findingKey: `Namespace/${ns}:no-network-policy`,
      severity: 'medium',
      description: `Namespace "${ns}" has running pods but no NetworkPolicy — every pod in it can be reached from, and can reach, every other pod in the cluster with no restriction.`,
      cisControl: 'CIS Kubernetes Benchmark §5.3 (Network Policies); NSA/CISA Kubernetes Hardening Guidance — Network Separation',
    });
  }

  return findings;
}

function _scanExposedServices(services) {
  const findings = [];
  for (const svc of services ?? []) {
    const ns   = svc.metadata?.namespace;
    const name = svc.metadata?.name;
    if (SKIP_NAMESPACES.has(ns)) continue;

    const type = svc.spec?.type;
    if (!EXPOSED_SERVICE_TYPES.has(type)) continue;

    findings.push({
      namespace: ns,
      resource:  { kind: 'Service', name, namespace: ns },
      findingKey: `Service/${ns}/${name}:exposed-${type}`,
      severity: 'medium',
      description: `Service "${name}" (ns: ${ns}) is type ${type} — ` +
        (type === 'NodePort'
          ? 'reachable directly on that port on every node\'s IP, bypassing any Ingress-level controls.'
          : 'provisions a public-facing load balancer — confirm this is intentional for this workload.'),
      cisControl: 'NSA/CISA Kubernetes Hardening Guidance — Network Separation and Hardening',
    });
  }
  return findings;
}

function _scanIngressesWithoutTls(ingresses) {
  const findings = [];
  for (const ing of ingresses ?? []) {
    const ns   = ing.metadata?.namespace;
    const name = ing.metadata?.name;
    if (SKIP_NAMESPACES.has(ns)) continue;

    const tls = ing.spec?.tls ?? [];
    if (tls.length > 0) continue;

    findings.push({
      namespace: ns,
      resource:  { kind: 'Ingress', name, namespace: ns },
      findingKey: `Ingress/${ns}/${name}:no-tls`,
      severity: 'medium',
      description: `Ingress "${name}" (ns: ${ns}) has no tls[] entry — traffic to it is served over plain HTTP.`,
      cisControl: 'NSA/CISA Kubernetes Hardening Guidance — Transport Encryption',
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
    const existing = await _SecurityFinding.findOne({ cluster, kind: 'NetworkExposure', findingKey: f.findingKey });
    if (existing) {
      existing.lastSeenAt = now;
      existing.severity   = f.severity;
      existing.description = f.description;
      if (existing.status === 'resolved') existing.status = 'open';
      await existing.save();
    } else {
      await _SecurityFinding.create({
        cluster, kind: 'NetworkExposure',
        namespace: f.namespace, findingKey: f.findingKey, severity: f.severity,
        resource: f.resource, description: f.description, cisControl: f.cisControl,
        detectedAt: now, lastSeenAt: now, status: 'open',
      });
      newCount++;
    }
  }

  await _SecurityFinding.updateMany(
    { cluster, kind: 'NetworkExposure', status: 'open', findingKey: { $nin: [...seenKeys] } },
    { $set: { status: 'resolved' } }
  );

  return newCount;
}

module.exports = new NetworkExposureEngine();
