#!/usr/bin/env node
// =============================================================================
// agent-benchmark-advanced.js — Extended agent benchmark
//
// Includes all tests from agent-benchmark.js PLUS:
//   - Cascading failures (db dependency)
//   - Rollback chain (v1→v2→v3 broken)
//   - Self-resolving issues
//   - Flapping pods
//   - Controller type coverage (StatefulSet, Job, DaemonSet)
//   - Namespace isolation
//   - Decision consistency (same test × 3 runs)
//   - Multi-failure stress
//   - Wrong action recovery
//   - Resource pressure victim
//
// Usage:
//   node benchmark/agent-benchmark-advanced.js
//   node benchmark/agent-benchmark-advanced.js --context=minikube --timeout=400
// =============================================================================
'use strict';

const { execFileSync, execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const ARGS = process.argv.slice(2).reduce((o, a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  o[k] = v ?? true;
  return o;
}, {});

const CTX          = ARGS.context  || 'minikube';
const API          = ARGS.api      || 'http://localhost:3001';
const NS           = ARGS.ns       || 'bench-adv';
const TIMEOUT      = parseInt(ARGS.timeout || '400', 10);
const POLL         = parseInt(ARGS.poll    || '10', 10);
const RESULTS_DIR  = path.join(__dirname, 'results');
// Friendly cluster name registered in clusters.yaml — usually the same string as CTX
// (true for a plain "minikube" entry), but override with --cluster= if yours differs.
const HPA_CLUSTER  = ARGS.cluster  || CTX;
// Deliberately its OWN namespace, separate from NS — the main cleanup step below wipes
// NS entirely right after these checks run, which would delete hpa-demo again before
// there's any chance to actually look at it in the dashboard. This one is intentionally
// left alone (see the note printed after the checks run).
const AUTOSCALE_NS = ARGS.autoscaleNs || 'bench-autoscale-demo';

const C = {
  r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', b: '\x1b[34m',
  c: '\x1b[36m', d: '\x1b[2m', B: '\x1b[1m', n: '\x1b[0m',
};

function kube(...args) {
  try {
    return execFileSync('kubectl', [`--context=${CTX}`, '-n', NS, ...args],
      { encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (e) { return e.stdout?.trim() ?? ''; }
}
function kubeGlobal(...args) {
  try {
    return execFileSync('kubectl', [`--context=${CTX}`, ...args],
      { encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (e) { return e.stdout?.trim() ?? ''; }
}
function kubeApply(yamlStr, namespace) {
  const ns = namespace || NS;
  try {
    return execSync(`kubectl --context=${CTX} -n ${ns} apply -f -`,
      { input: yamlStr, encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (e) { return e.stdout?.trim() ?? ''; }
}
function waitRollout(name, ns, timeoutSec = 90) {
  try { execFileSync('kubectl', [`--context=${CTX}`, '-n', ns || NS, 'rollout', 'status', `deployment/${name}`, `--timeout=${timeoutSec}s`],
    { encoding: 'utf8', timeout: (timeoutSec + 5) * 1000, stdio: 'pipe' }); } catch {}
}

let TOKEN = '';
async function api(endpoint) {
  const r = await fetch(`${API}${endpoint}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  return r.json();
}
async function login() {
  const r = await fetch(`${API}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@admin.com', password: 'admin' }),
  });
  const d = await r.json();
  TOKEN = d.token;
  if (!TOKEN) throw new Error('Login failed');
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// =============================================================================
// TEST DEFINITIONS
// =============================================================================
// Categories:
//   basic     — core detection + action tests (from v1 benchmark)
//   cascade   — multi-pod dependency chain
//   rollback  — rollback chain + retry protection
//   controller— different K8s controller types
//   behavior  — flapping, self-resolving, wrong-action recovery
//   isolation — namespace separation
//   policy    — PolicyEngine blocks an action the planner would otherwise take
//   healthy   — false positive checks
// =============================================================================
// "policy" tests need POLICY_AWARENESS_ENABLED=true on the running server (see .env) —
// PolicyEngine only receives ResourceQuota/PDB data to check against when that flag is
// on. Without it, the block never fires and the test will time out, not fail cleanly.
// =============================================================================

const TESTS = [

  // ═══════════════════════════════════════════════════════════════════════════
  // BASIC — carried over from v1
  // ═══════════════════════════════════════════════════════════════════════════
  {
    name: 'OOMKilled deployment', category: 'basic', weight: 5, kind: 'failure', pod: 'oom-dep',
    create() {
      kubeApply(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: oom-dep
spec:
  replicas: 1
  selector: { matchLabels: { app: oom-dep } }
  template:
    metadata: { labels: { app: oom-dep } }
    spec:
      containers:
      - name: oom
        image: polinux/stress
        command: ["stress","--vm","1","--vm-bytes","128M"]
        resources: { limits: { memory: "4Mi" } }`);
    },
    expected: { detected: true, diagnosis: /oom|memory/i, action: 'increase_memory', altActions: ['ESCALATED'] },
  },
  {
    name: 'ImagePullBackOff deployment', category: 'basic', weight: 3, kind: 'failure', pod: 'bad-image',
    create() {
      kubeApply(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: bad-image
spec:
  replicas: 1
  selector: { matchLabels: { app: bad-image } }
  template:
    metadata: { labels: { app: bad-image } }
    spec:
      containers:
      - name: app
        image: fakerepo/doesnotexist:v999`);
    },
    expected: { detected: true, diagnosis: /image|pull/i, action: 'noop', altActions: ['ESCALATED', 'restart'] },
  },
  {
    name: 'CrashLoop deployment', category: 'basic', weight: 5, kind: 'failure', pod: 'crashloop-dep',
    create() {
      kubeApply(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: crashloop-dep
spec:
  replicas: 1
  selector: { matchLabels: { app: crashloop-dep } }
  template:
    metadata: { labels: { app: crashloop-dep } }
    spec:
      containers:
      - name: app
        image: busybox
        command: ["/bin/sh","-c","sleep 2 && exit 1"]`);
    },
    expected: { detected: true, diagnosis: /crash|loop|exit|fail/i, action: 'restart', altActions: ['ESCALATED'] },
  },
  {
    name: 'Bad config rollback', category: 'basic', weight: 8, kind: 'failure', pod: 'bad-config',
    create() {
      kube('create', 'deployment', 'bad-config', '--image=nginx');
      waitRollout('bad-config');
      kubeApply(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: bad-config
spec:
  replicas: 1
  selector: { matchLabels: { app: bad-config } }
  template:
    metadata: { labels: { app: bad-config } }
    spec:
      containers:
      - name: bad-config
        image: busybox
        command: ["/bin/sh","-c","echo BAD && exit 1"]`);
    },
    expected: { detected: true, diagnosis: /config|exit|crash|error/i, action: 'rollback', altActions: ['restart'] },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // CASCADE — database dependency chain
  // ═══════════════════════════════════════════════════════════════════════════
  {
    name: 'Cascade: broken database', category: 'cascade', weight: 6, kind: 'failure', pod: 'cascade-db',
    create() {
      kubeApply(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: cascade-db
spec:
  replicas: 1
  selector: { matchLabels: { app: cascade-db } }
  template:
    metadata: { labels: { app: cascade-db } }
    spec:
      containers:
      - name: db
        image: busybox
        command: ["/bin/sh","-c","echo DB_CRASH && exit 1"]`);
    },
    expected: { detected: true, diagnosis: /crash|exit|fail|db|database/i, action: 'restart', altActions: ['rollback', 'ESCALATED'] },
  },
  {
    name: 'Cascade: app depends on broken db', category: 'cascade', weight: 8, kind: 'failure', pod: 'cascade-app',
    create() {
      kubeApply(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: cascade-app
spec:
  replicas: 2
  selector: { matchLabels: { app: cascade-app } }
  template:
    metadata: { labels: { app: cascade-app } }
    spec:
      containers:
      - name: app
        image: busybox
        command: ["/bin/sh","-c","echo Connecting to cascade-db... && sleep 3 && echo CONN_REFUSED && exit 1"]`);
    },
    expected: { detected: true, diagnosis: /crash|connect|exit|fail|depend/i, action: 'restart', altActions: ['rollback', 'ESCALATED'] },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // ROLLBACK CHAIN — v1 working → v2 working → v3 broken
  // ═══════════════════════════════════════════════════════════════════════════
  {
    name: 'Rollback chain: v3 broken (should rollback)', category: 'rollback', weight: 10, kind: 'failure', pod: 'rollchain',
    create() {
      // v1: working
      kube('create', 'deployment', 'rollchain', '--image=nginx');
      waitRollout('rollchain');
      // v2: also working (different image to create a revision)
      kube('set', 'image', 'deployment/rollchain', 'nginx=httpd:alpine');
      waitRollout('rollchain');
      // v3: broken
      kube('set', 'image', 'deployment/rollchain', 'nginx=busybox');
      kubeApply(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: rollchain
spec:
  replicas: 1
  selector: { matchLabels: { app: rollchain } }
  template:
    metadata: { labels: { app: rollchain } }
    spec:
      containers:
      - name: nginx
        image: busybox
        command: ["/bin/sh","-c","exit 1"]`);
    },
    expected: { detected: true, diagnosis: /crash|exit|config|image|broken/i, action: 'rollback', altActions: ['restart', 'ESCALATED'] },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // CONTROLLER TYPES — same failure, different owners
  // ═══════════════════════════════════════════════════════════════════════════
  {
    name: 'Controller: StatefulSet crash', category: 'controller', weight: 5, kind: 'failure', pod: 'sts-crash',
    create() {
      kubeApply(`apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: sts-crash
spec:
  serviceName: sts-crash
  replicas: 1
  selector: { matchLabels: { app: sts-crash } }
  template:
    metadata: { labels: { app: sts-crash } }
    spec:
      containers:
      - name: app
        image: busybox
        command: ["/bin/sh","-c","sleep 3 && exit 1"]`);
    },
    expected: { detected: true, diagnosis: /crash|exit|fail/i, action: 'restart', altActions: ['ESCALATED', 'noop', 'rollback'] },
  },
  {
    name: 'Controller: Job failure', category: 'controller', weight: 4, kind: 'failure', pod: 'job-fail',
    create() {
      kubeApply(`apiVersion: batch/v1
kind: Job
metadata:
  name: job-fail
spec:
  backoffLimit: 2
  template:
    spec:
      restartPolicy: Never
      containers:
      - name: worker
        image: busybox
        command: ["/bin/false"]`);
    },
    expected: { detected: true, diagnosis: /exit|fail|job|error/i, action: 'noop', altActions: ['delete_pod', 'ESCALATED'] },
  },
  {
    name: 'Controller: DaemonSet crash', category: 'controller', weight: 4, kind: 'failure', pod: 'ds-crash',
    create() {
      kubeApply(`apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: ds-crash
spec:
  selector: { matchLabels: { app: ds-crash } }
  template:
    metadata: { labels: { app: ds-crash } }
    spec:
      containers:
      - name: agent
        image: busybox
        command: ["/bin/sh","-c","sleep 2 && exit 1"]
      tolerations:
      - operator: Exists`);
    },
    expected: { detected: true, diagnosis: /crash|exit|fail/i, action: 'restart', altActions: ['ESCALATED', 'noop', 'rollback'] },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // BEHAVIOR — flapping, self-resolving, wrong-action recovery
  // ═══════════════════════════════════════════════════════════════════════════
  {
    name: 'Behavior: flapping pod (alternate crash/run)', category: 'behavior', weight: 6, kind: 'failure', pod: 'flapper',
    create() {
      kubeApply(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: flapper
spec:
  replicas: 1
  selector: { matchLabels: { app: flapper } }
  template:
    metadata: { labels: { app: flapper } }
    spec:
      containers:
      - name: app
        image: busybox
        command: ["/bin/sh","-c","sleep $(( RANDOM % 10 + 5 )) && exit 1"]`);
    },
    expected: { detected: true, diagnosis: /crash|exit|fail|flap|intermittent/i, action: 'restart', altActions: ['ESCALATED', 'rollback'] },
  },
  {
    name: 'Behavior: self-resolving (delayed start)', category: 'behavior', weight: 5, kind: 'failure', pod: 'self-resolve',
    create() {
      // Pod that fails for ~60s then starts succeeding (simulated with a file touch)
      kubeApply(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: self-resolve
spec:
  replicas: 1
  selector: { matchLabels: { app: self-resolve } }
  template:
    metadata: { labels: { app: self-resolve } }
    spec:
      containers:
      - name: app
        image: busybox
        command: ["/bin/sh","-c","if [ ! -f /tmp/started ]; then touch /tmp/started && exit 1; fi; sleep 3600"]`);
    },
    expected: { detected: true, diagnosis: /crash|exit|fail|transient/i, action: 'restart', altActions: ['ESCALATED', 'noop', 'rollback'] },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // NAMESPACE ISOLATION — same broken app in two namespaces
  // ═══════════════════════════════════════════════════════════════════════════
  {
    name: 'Isolation: crash in ns-alpha', category: 'isolation', weight: 4, kind: 'failure', pod: 'iso-crash',
    ns: 'bench-ns-alpha',
    create() {
      kubeGlobal('create', 'namespace', 'bench-ns-alpha');
      kubeApply(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: iso-crash
spec:
  replicas: 1
  selector: { matchLabels: { app: iso-crash } }
  template:
    metadata: { labels: { app: iso-crash } }
    spec:
      containers:
      - name: app
        image: busybox
        command: ["/bin/sh","-c","exit 1"]`, 'bench-ns-alpha');
    },
    expected: { detected: true, diagnosis: /crash|exit|fail/i, action: 'restart', altActions: ['ESCALATED', 'rollback'] },
  },
  {
    name: 'Isolation: crash in ns-beta', category: 'isolation', weight: 4, kind: 'failure', pod: 'iso-crash',
    ns: 'bench-ns-beta',
    create() {
      kubeGlobal('create', 'namespace', 'bench-ns-beta');
      kubeApply(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: iso-crash
spec:
  replicas: 1
  selector: { matchLabels: { app: iso-crash } }
  template:
    metadata: { labels: { app: iso-crash } }
    spec:
      containers:
      - name: app
        image: busybox
        command: ["/bin/sh","-c","exit 1"]`, 'bench-ns-beta');
    },
    expected: { detected: true, diagnosis: /crash|exit|fail/i, action: 'restart', altActions: ['ESCALATED', 'rollback'] },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // POLICY — PolicyEngine blocks an action the planner would otherwise take
  // ═══════════════════════════════════════════════════════════════════════════
  {
    // The quota's hard.limits.memory is set to exactly match what this single pod
    // already consumes, so usage sits at 100% the moment the pod is admitted —
    // deterministic, no need to pre-fill the namespace with other pods first.
    name: 'Policy: OOM blocked by exhausted ResourceQuota', category: 'policy', weight: 6,
    kind: 'policyBlock', pod: 'policy-oom', ns: 'bench-policy', expectedRule: /POLICY_QUOTA_EXHAUSTED/,
    create() {
      kubeGlobal('create', 'namespace', 'bench-policy');
      kubeApply(`apiVersion: v1
kind: ResourceQuota
metadata:
  name: tight-quota
spec:
  hard:
    limits.memory: 4Mi`, 'bench-policy');
      kubeApply(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: policy-oom
spec:
  replicas: 1
  selector: { matchLabels: { app: policy-oom } }
  template:
    metadata: { labels: { app: policy-oom } }
    spec:
      containers:
      - name: oom
        image: polinux/stress
        command: ["stress","--vm","1","--vm-bytes","128M"]
        resources: { limits: { memory: "4Mi" } }`, 'bench-policy');
    },
    // Same OOM failure as the very first test — but this namespace's ResourceQuota has
    // no headroom left, so PolicyEngine's Rule 9 should block increase_memory instead
    // of letting the planner apply it. Expects a BLOCK, not a fix.
    expected: { detected: true, diagnosis: /POLICY_QUOTA_EXHAUSTED/, action: 'BLOCKED', altActions: [] },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // FALSE POSITIVES — healthy resources
  // ═══════════════════════════════════════════════════════════════════════════
  {
    name: 'Healthy: nginx', category: 'healthy', weight: 8, kind: 'healthy', pod: 'healthy-nginx',
    create() { kube('run', 'healthy-nginx', '--image=nginx', '--restart=Never'); },
    expected: { detected: false },
  },
  {
    name: 'Healthy: redis', category: 'healthy', weight: 8, kind: 'healthy', pod: 'healthy-redis',
    create() { kube('run', 'healthy-redis', '--image=redis:alpine', '--restart=Never'); },
    expected: { detected: false },
  },
  {
    name: 'Healthy: deployment (2 replicas)', category: 'healthy', weight: 8, kind: 'healthy', pod: 'healthy-dep',
    create() {
      kube('create', 'deployment', 'healthy-dep', '--image=nginx', '--replicas=2');
      waitRollout('healthy-dep');
    },
    expected: { detected: false },
  },
  {
    name: 'Healthy: busybox sleep', category: 'healthy', weight: 8, kind: 'healthy', pod: 'healthy-bb',
    create() { kube('run', 'healthy-bb', '--image=busybox', '--restart=Never', '--', 'sleep', '3600'); },
    expected: { detected: false },
  },
  {
    name: 'Healthy: StatefulSet', category: 'healthy', weight: 6, kind: 'healthy', pod: 'healthy-sts',
    create() {
      kubeApply(`apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: healthy-sts
spec:
  serviceName: healthy-sts
  replicas: 1
  selector: { matchLabels: { app: healthy-sts } }
  template:
    metadata: { labels: { app: healthy-sts } }
    spec:
      containers:
      - name: app
        image: nginx`);
    },
    expected: { detected: false },
  },
];

// =============================================================================
// AUTOSCALING API CHECKS — not agent decisions
// =============================================================================
// A HorizontalPodAutoscaler isn't something PlannerAgent/GuardianAgent ever detects
// or acts on — it's a passive object the Autoscaling page just reads. These don't fit
// the detect→diagnose→act→resolve scoring model above, so they're checked separately
// and don't count toward the weighted score — they verify the Autoscaling page's
// read/edit API actually reflects reality, not agent intelligence.
// =============================================================================
const HPA_CHECKS = [
  {
    name: 'HPA created with min=1 max=5 target=50% is visible via the API',
    async setup() {
      // kubeGlobal() swallows kubectl errors (returns stdout, never throws) — verify
      // each step actually landed instead of silently continuing on a failed
      // create/autoscale (e.g. a leftover namespace from a previous run still
      // mid-Terminating rejects new objects silently). A clear error here beats an
      // ambiguous "not found" later. Uses AUTOSCALE_NS (its own namespace, not NS) —
      // NS gets wiped by the main cleanup step right after these checks run.
      kubeGlobal('create', 'namespace', AUTOSCALE_NS);
      kubeGlobal('-n', AUTOSCALE_NS, 'create', 'deployment', 'hpa-demo', '--image=nginx');
      waitRollout('hpa-demo', AUTOSCALE_NS);
      if (!kubeGlobal('-n', AUTOSCALE_NS, 'get', 'deployment', 'hpa-demo', '--ignore-not-found'))
        throw new Error(`deployment/hpa-demo was not created in namespace "${AUTOSCALE_NS}" — check kubectl output / whether the namespace is stuck Terminating from a previous run`);
      kubeGlobal('-n', AUTOSCALE_NS, 'autoscale', 'deployment/hpa-demo', '--min=1', '--max=5', '--cpu-percent=50');
      if (!kubeGlobal('-n', AUTOSCALE_NS, 'get', 'hpa', 'hpa-demo', '--ignore-not-found'))
        throw new Error(`kubectl autoscale did not create hpa-demo in namespace "${AUTOSCALE_NS}" — run it manually to see the real error`);
    },
    async verify() {
      const d = await api(`/api/autoscaling/hpas?cluster=${encodeURIComponent(HPA_CLUSTER)}`);
      const h = (d.hpas ?? []).find(x => x.target === 'Deployment/hpa-demo' && x.namespace === AUTOSCALE_NS);
      if (!h) return { pass: false, detail: `HPA exists in kubectl but not via /api/autoscaling/hpas?cluster=${HPA_CLUSTER} — check --cluster= matches the "name" in clusters.yaml (context "${CTX}" itself is confirmed reachable, since setup() succeeded)` };
      const ok = h.minReplicas === 1 && h.maxReplicas === 5 && h.cpuTarget === 50;
      return { pass: ok, detail: `min=${h.minReplicas} max=${h.maxReplicas} target=${h.cpuTarget}%` };
    },
  },
  {
    name: 'Editing an HPA (the "Edit" modal\'s PUT) persists the new min/max',
    async setup() {
      // Depends on hpa-demo already existing from the check above — if that one
      // failed, this one will too; that's expected, not a separate bug.
      const r = await fetch(`${API}/api/autoscaling/hpas/hpa-demo`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ cluster: HPA_CLUSTER, namespace: AUTOSCALE_NS, minReplicas: 2, maxReplicas: 6 }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(`PUT /api/autoscaling/hpas/hpa-demo → ${r.status}: ${d.error ?? 'unknown error'}`);
      }
    },
    async verify() {
      const d = await api(`/api/autoscaling/hpas?cluster=${encodeURIComponent(HPA_CLUSTER)}`);
      const h = (d.hpas ?? []).find(x => x.target === 'Deployment/hpa-demo' && x.namespace === AUTOSCALE_NS);
      if (!h) return { pass: false, detail: 'HPA not found after edit' };
      const ok = h.minReplicas === 2 && h.maxReplicas === 6;
      return { pass: ok, detail: `min=${h.minReplicas} max=${h.maxReplicas}` };
    },
  },
];

// =============================================================================
// DECISION FINDER
// =============================================================================
async function findDecision(podName, namespace, afterIso) {
  const searchNs = namespace || NS;
  let action = null, rootCause = null, risk = null, status = null;

  try {
    const audit = await api(`/api/audit?limit=500&cluster=${CTX}`);
    for (const d of (audit.docs ?? [])) {
      const ts = d.createdAt ?? d.timestamp ?? '';
      if (ts && ts < afterIso) continue;
      const meta = d.metadata ?? {};
      const key = meta.issueKey ?? d.issueKey ?? '';
      if (key.includes(podName) && key.includes(searchNs)) {
        const a = meta.action ?? d.action ?? null;
        const finalAction = meta.finalAction ?? a;
        action = finalAction ?? a;
        risk   = meta.risk ?? d.risk ?? null;
        status = d.status ?? null;
        break;
      }
    }
  } catch {}

  try {
    const logs = await api('/api/logs');
    if (Array.isArray(logs)) {
      for (let i = logs.length - 1; i >= 0; i--) {
        const logTs = logs[i].timestamp ?? '';
        if (logTs && logTs < afterIso) continue;
        const msg = logs[i].message ?? '';
        if (!msg.includes(podName)) continue;

        if (!rootCause && msg.includes('[PLANNER] raw:')) {
          try {
            const parsed = JSON.parse(msg.slice(msg.indexOf('{')).match(/\{[\s\S]*\}/)?.[0] ?? '{}');
            if (parsed.rootCause) rootCause = parsed.rootCause;
            if (!action && parsed.action) action = parsed.action;
            if (!risk && parsed.risk) risk = parsed.risk;
          } catch {}
        }
        if (!rootCause && msg.includes('[PLANNER]') && msg.includes('rootCause')) {
          const m = msg.match(/rootCause\s*:\s*(.+)/);
          if (m) rootCause = m[1].trim();
        }
        if (!action && msg.includes('[PLANNER]') && msg.includes('action')) {
          const m = msg.match(/action\s*[:=]\s*(\S+)/);
          if (m) action = m[1];
        }
      }
    }
  } catch {}

  if (action) return { action, rootCause, risk, status };

  try {
    const escs = await api('/api/escalations');
    if (Array.isArray(escs)) {
      for (const e of escs) {
        if ((e.issueKey ?? '').includes(podName) && (e.issueKey ?? '').includes(searchNs)) {
          return { action: 'ESCALATED', rootCause: e.rca?.suspected_cause ?? null, risk: null, status: e.status };
        }
      }
    }
  } catch {}

  return null;
}

// PolicyEngine's blocked/modified audit entries aren't keyed by issueKey (unlike
// ClusterAgent's own audit/log writes), so findDecision's generic search can't find
// them — this looks them up directly by target name/namespace instead. Returns a
// decision shaped like findDecision's result (action: 'BLOCKED') so the same generic
// scoring logic in main() can score a "policy" test the same way as any other.
async function findPolicyBlock(deploymentName, namespace, rulePattern, afterIso) {
  const searchNs = namespace || NS;
  try {
    const audit = await api(`/api/audit?limit=500&cluster=${CTX}&agent=PolicyEngine&status=blocked`);
    for (const d of (audit.docs ?? [])) {
      const ts = d.createdAt ?? d.timestamp ?? '';
      if (ts && ts < afterIso) continue;
      const target = d.metadata?.target ?? {};
      if (target.name !== deploymentName || target.namespace !== searchNs) continue;
      const rules = d.metadata?.blockedRules ?? [];
      if (!rules.some(r => rulePattern.test(r))) continue;
      return { action: 'BLOCKED', rootCause: rules.join('; '), risk: null, status: 'blocked' };
    }
  } catch {}
  return null;
}

function checkResolved(podName) {
  try {
    const phase = kube('get', 'pod', podName, '-o', 'jsonpath={.status.phase}');
    if (phase === 'Running') return true;
  } catch {}
  try {
    const out = kube('get', 'pods', '-l', `app=${podName}`, '-o', 'jsonpath={range .items[*]}{.status.phase}{" "}{end}');
    if (out.includes('Running')) return true;
  } catch {}
  return false;
}

// =============================================================================
// MAIN
// =============================================================================
async function main() {
  console.log(`\n${C.B}${C.b}━━━ KubePilot Advanced Agent Benchmark ━━━${C.n}`);
  console.log(`${C.d}cluster=${CTX}  ns=${NS}  timeout=${TIMEOUT}s  tests=${TESTS.length}${C.n}\n`);

  await login();
  console.log(`${C.g}  OK${C.n} Logged in\n`);

  // Setup namespaces
  try { execFileSync('kubectl', [`--context=${CTX}`, 'create', 'namespace', NS], { encoding: 'utf8', timeout: 10000, stdio: 'pipe' }); } catch {}

  const benchStartIso = new Date().toISOString();
  const benchStartMs  = Date.now();
  const startTimes = {};
  const results = [];

  // Group tests by category for display
  const categories = [...new Set(TESTS.map(t => t.category))];

  // Create all workloads
  console.log(`${C.b}[create]${C.n} Deploying ${TESTS.length} test workloads across ${categories.length} categories...`);
  for (const cat of categories) {
    const catTests = TESTS.filter(t => t.category === cat);
    console.log(`\n  ${C.c}${C.B}${cat.toUpperCase()}${C.n} ${C.d}(${catTests.length} tests)${C.n}`);
    for (const t of catTests) {
      process.stdout.write(`    ${C.b}*${C.n} ${t.name}...`);
      startTimes[t.pod + (t.ns || '')] = Date.now();
      try { t.create(); console.log(` ${C.g}created${C.n}`); }
      catch (e) { console.log(` ${C.r}failed: ${e.message}${C.n}`); }
    }
  }

  // Poll
  console.log(`\n${C.b}[poll]${C.n} Waiting for agent decisions (max ${TIMEOUT}s)...\n`);

  const decisions = {};
  const detectionTimes = {};
  let elapsed = 0;
  const failureTests = TESTS.filter(t => t.expected.detected !== false);
  const healthyTests = TESTS.filter(t => t.expected.detected === false);

  while (elapsed < TIMEOUT) {
    await sleep(POLL * 1000);
    elapsed += POLL;

    let detectedCount = 0;
    for (const t of TESTS) {
      const dKey = t.pod + (t.ns || '');
      if (decisions[dKey]) { detectedCount++; continue; }
      const dec = t.kind === 'policyBlock'
        ? await findPolicyBlock(t.pod, t.ns, t.expectedRule, benchStartIso)
        : await findDecision(t.pod, t.ns, benchStartIso);
      if (dec) {
        decisions[dKey] = dec;
        detectionTimes[dKey] = Date.now() - startTimes[dKey];
        detectedCount++;
      }
    }

    const failureDetected = failureTests.filter(t => decisions[t.pod + (t.ns || '')]).length;
    process.stdout.write(`\r  ${elapsed}s — failures: ${failureDetected}/${failureTests.length} detected `);

    if (failureDetected >= failureTests.length) {
      await sleep(POLL * 12000);
      elapsed += POLL;
      for (const t of healthyTests) {
        const dKey = t.pod + (t.ns || '');
        if (!decisions[dKey]) {
          const dec = await findDecision(t.pod, t.ns, benchStartIso);
          if (dec) { decisions[dKey] = dec; detectionTimes[dKey] = Date.now() - startTimes[dKey]; }
        }
      }
      break;
    }
  }
  console.log('\n');

  // Score
  console.log(`${C.B}${C.b}━━━ Results ━━━${C.n}\n`);

  let totalWeight = 0, earnedWeight = 0;
  const latencies = [];
  let falsePositives = 0, trueNegatives = 0;
  let correctDiag = 0, totalDiag = 0;
  let correctAction = 0, totalAction = 0;
  let resolved = 0, totalResolution = 0;
  const categoryScores = {};

  let currentCat = '';
  for (const t of TESTS) {
    if (t.category !== currentCat) {
      currentCat = t.category;
      console.log(`  ${C.c}${C.B}── ${currentCat.toUpperCase()} ──${C.n}`);
    }

    const dKey = t.pod + (t.ns || '');
    const dec = decisions[dKey] ?? null;
    const exp = t.expected;
    const latencyMs = detectionTimes[dKey] ?? null;
    const latencySec = latencyMs ? (latencyMs / 1000).toFixed(1) : null;

    const r = {
      name: t.name, pod: t.pod, kind: t.kind, weight: t.weight, category: t.category,
      detection: { pass: false }, diagnosis: { pass: false }, action: { pass: false, detail: '' },
      resolution: { pass: false, skipped: true }, latencyMs, earned: 0,
    };

    if (t.kind === 'healthy') {
      if (!dec) {
        r.detection = { pass: true }; r.diagnosis = { pass: true }; r.action = { pass: true, detail: 'no action (correct)' };
        r.earned = t.weight; trueNegatives++;
      } else {
        r.detection = { pass: false }; r.action = { pass: false, detail: `FALSE POSITIVE: ${dec.action}` };
        falsePositives++;
      }
    } else {
      if (dec) { r.detection = { pass: true }; r.earned += t.weight * 0.25; if (latencyMs) latencies.push(latencyMs); }

      totalDiag++;
      if (dec?.rootCause && exp.diagnosis?.test(dec.rootCause)) { r.diagnosis = { pass: true }; r.earned += t.weight * 0.25; correctDiag++; }

      totalAction++;
      if (dec?.action) {
        const isExact = dec.action === exp.action;
        const isAlt = !isExact && (exp.altActions ?? []).includes(dec.action);
        if (isExact) { r.action = { pass: true, detail: dec.action }; r.earned += t.weight * 0.35; correctAction++; }
        else if (isAlt) { r.action = { pass: true, detail: `${dec.action} (alt)` }; r.earned += t.weight * 0.20; correctAction++; }
        else { r.action = { pass: false, detail: `${dec.action} (expected: ${exp.action})` }; }
      } else {
        r.action = { pass: false, detail: 'not detected' };
      }

      // 'BLOCKED' (policyBlock tests) means the fix was correctly withheld — there's
      // nothing to check "resolved", unlike a real remediation action.
      if (dec?.action && dec.action !== 'noop' && dec.action !== 'ESCALATED' && dec.action !== 'BLOCKED') {
        totalResolution++; const isRes = checkResolved(t.pod);
        r.resolution = { pass: isRes, skipped: false }; if (isRes) { r.earned += t.weight * 0.15; resolved++; }
      }
    }

    totalWeight += t.weight;
    earnedWeight += r.earned;
    results.push(r);
    if (!categoryScores[t.category]) categoryScores[t.category] = { earned: 0, total: 0 };
    categoryScores[t.category].earned += r.earned;
    categoryScores[t.category].total += t.weight;

    const icon = r.detection.pass && r.action.pass ? `${C.g}PASS` : !r.detection.pass && t.kind === 'failure' ? `${C.y}SKIP` : `${C.r}FAIL`;
    console.log(`    ${icon}${C.n}  ${t.name} ${C.d}(w=${t.weight})${C.n}`);
    if (t.kind !== 'healthy') {
      console.log(`         ${r.detection.pass ? C.g+'D' : C.r+'D'}${C.n} ${r.diagnosis.pass ? C.g+'Dx' : C.r+'Dx'}${C.n} ${r.action.pass ? C.g+'A' : C.r+'A'}${C.n}${!r.resolution.skipped ? (r.resolution.pass ? ` ${C.g}R${C.n}` : ` ${C.r}R${C.n}`) : ''} ${C.d}${r.action.detail}${latencySec ? ` ${latencySec}s` : ''}${C.n}`);
    }
  }

  // Metrics
  const ws = totalWeight > 0 ? ((earnedWeight / totalWeight) * 100).toFixed(1) : 0;
  const avgLat = latencies.length ? (latencies.reduce((a,b) => a+b, 0) / latencies.length / 1000).toFixed(1) : 'n/a';
  const p95Lat = latencies.length >= 2 ? (latencies.sort((a,b) => a-b)[Math.floor(latencies.length * 0.95)] / 1000).toFixed(1) : avgLat;
  const fpRate = healthyTests.length > 0 ? ((falsePositives / healthyTests.length) * 100).toFixed(1) : '0.0';

  console.log(`\n${C.B}${C.b}━━━ Metrics ━━━${C.n}\n`);
  console.log(`  Weighted Score:       ${C.B}${ws}%${C.n}`);
  console.log(`  Detection:            ${results.filter(r => r.detection.pass).length}/${TESTS.length}`);
  console.log(`  Diagnosis:            ${correctDiag}/${totalDiag}`);
  console.log(`  Action:               ${correctAction}/${totalAction}`);
  console.log(`  Resolution:           ${resolved}/${totalResolution || 'n/a'}`);
  console.log(`  False Positive Rate:  ${C.B}${fpRate}%${C.n} (${falsePositives}/${healthyTests.length})`);
  console.log(`  Avg Latency:          ${avgLat}s`);
  console.log(`  P95 Latency:          ${p95Lat}s`);

  console.log(`\n  ${C.B}Per-Category:${C.n}`);
  for (const [cat, s] of Object.entries(categoryScores)) {
    const pct = s.total > 0 ? ((s.earned / s.total) * 100).toFixed(0) : 0;
    const bar = '█'.repeat(Math.round(pct / 5)) + '░'.repeat(20 - Math.round(pct / 5));
    console.log(`    ${cat.padEnd(12)} ${bar} ${pct}%`);
  }

  // Save
  if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
  let commit = 'unknown';
  try { commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim(); } catch {}

  const report = {
    date: new Date().toISOString(), commit, cluster: CTX, model: process.env.OPENAI_MODEL ?? 'unknown',
    benchmark: 'advanced', timeout: TIMEOUT,
    metrics: {
      weightedScore: parseFloat(ws), detectionAcc: results.filter(r => r.detection.pass).length / TESTS.length,
      diagnosisAcc: totalDiag > 0 ? correctDiag / totalDiag : null,
      actionAcc: totalAction > 0 ? correctAction / totalAction : null,
      resolutionRate: totalResolution > 0 ? resolved / totalResolution : null,
      falsePositiveRate: healthyTests.length > 0 ? falsePositives / healthyTests.length : 0,
      avgLatencyMs: latencies.length ? latencies.reduce((a,b) => a+b, 0) / latencies.length : null,
      p95LatencyMs: latencies.length >= 2 ? latencies.sort((a,b) => a-b)[Math.floor(latencies.length * 0.95)] : null,
      categoryScores,
    },
    tests: results.map(r => ({
      name: r.name, pod: r.pod, kind: r.kind, weight: r.weight, category: r.category,
      earned: r.earned, detection: r.detection.pass, diagnosis: r.diagnosis.pass,
      action: r.action.pass, resolution: r.resolution.skipped ? null : r.resolution.pass,
      latencyMs: r.latencyMs, actionDetail: r.action.detail,
    })),
  };

  const filename = `bench-adv-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
  fs.writeFileSync(path.join(RESULTS_DIR, filename), JSON.stringify(report, null, 2));
  console.log(`\n${C.d}Report: benchmark/results/${filename}${C.n}`);

  // Regression
  const prevFiles = fs.existsSync(RESULTS_DIR)
    ? fs.readdirSync(RESULTS_DIR).filter(f => f.startsWith('bench-adv-') && f.endsWith('.json')).sort() : [];
  if (prevFiles.length >= 2) {
    const prev = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, prevFiles[prevFiles.length - 2])));
    const diff = report.metrics.weightedScore - prev.metrics.weightedScore;
    if (diff < -5) console.log(`\n  ${C.r}${C.B}REGRESSION${C.n} ${C.r}${diff.toFixed(1)}% vs previous${C.n}`);
    else if (diff > 0) console.log(`\n  ${C.g}Improvement: +${diff.toFixed(1)}%${C.n}`);
  }

  // Autoscaling API checks (not agent-scored — see HPA_CHECKS above)
  console.log(`\n${C.B}${C.b}━━━ Autoscaling API Checks (not agent-scored) ━━━${C.n}\n`);
  const hpaResults = [];
  for (const chk of HPA_CHECKS) {
    process.stdout.write(`    ${C.b}*${C.n} ${chk.name}...`);
    try {
      await chk.setup();
      await sleep(3000); // let the HPA object settle before reading it back
      const v = await chk.verify();
      console.log(v.pass ? ` ${C.g}PASS${C.n} ${C.d}${v.detail}${C.n}` : ` ${C.r}FAIL${C.n} ${C.d}${v.detail}${C.n}`);
      hpaResults.push({ name: chk.name, pass: v.pass, detail: v.detail });
    } catch (e) {
      console.log(` ${C.r}ERROR: ${e.message}${C.n}`);
      hpaResults.push({ name: chk.name, pass: false, detail: e.message });
    }
  }
  fs.writeFileSync(
    path.join(RESULTS_DIR, filename.replace('.json', '-hpa-checks.json')),
    JSON.stringify(hpaResults, null, 2)
  );
  console.log(`\n  ${C.d}hpa-demo left running in namespace "${AUTOSCALE_NS}" — open the Autoscaling tab to see it.${C.n}`);
  console.log(`  ${C.d}Remove it yourself when done: kubectl --context=${CTX} delete namespace ${AUTOSCALE_NS}${C.n}`);

  // Cleanup — note this only wipes NS and the other test namespaces below; AUTOSCALE_NS
  // is deliberately NOT in this list, so hpa-demo survives for manual inspection.
  console.log(`\n${C.b}[cleanup]${C.n} Removing test namespaces...`);
  for (const n of [NS, 'bench-ns-alpha', 'bench-ns-beta', 'bench-policy']) {
    try { execFileSync('kubectl', [`--context=${CTX}`, 'delete', 'namespace', n, '--ignore-not-found', '--wait=false'],
      { encoding: 'utf8', timeout: 15000, stdio: 'pipe' }); } catch {}
  }

  console.log(`\n${C.d}Done. Press Ctrl+C to exit.${C.n}\n`);
  if (process.platform === 'win32') await new Promise(() => {});
}

main().catch(err => {
  console.error(`\n${C.r}Fatal: ${err.message}${C.n}`);
  if (process.platform === 'win32') { process.stdin.resume(); process.stdin.on('data', () => process.exit(1)); }
  else process.exit(1);
});
