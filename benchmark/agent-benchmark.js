#!/usr/bin/env node
// =============================================================================
// agent-benchmark.js — Production-grade agent decision benchmark
//
// Scores: Detection, Diagnosis, Action, Resolution, False Positives, Latency
// Outputs: JSON report + console summary + regression file
//
// Usage:
//   node benchmark/agent-benchmark.js
//   node benchmark/agent-benchmark.js --context=cluster2 --timeout=300 --stress
// =============================================================================
'use strict';

const { execFileSync, execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

// ── Config ─────────────────────────────────────────────────────────────────
const ARGS = process.argv.slice(2).reduce((o, a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  o[k] = v ?? true;
  return o;
}, {});

const CTX          = ARGS.context  || 'minikube';
const API          = ARGS.api      || 'http://localhost:3001';
const NS           = ARGS.ns       || 'agent-bench';
const TIMEOUT      = parseInt(ARGS.timeout || '1000', 10);
const POLL         = parseInt(ARGS.poll    || '8', 10);
const STRESS       = !!ARGS.stress;
const RESULTS_DIR  = path.join(__dirname, 'results');

// ── Colors ─────────────────────────────────────────────────────────────────
const C = {
  r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', b: '\x1b[34m',
  d: '\x1b[2m', B: '\x1b[1m', n: '\x1b[0m',
};

// ── Helpers ────────────────────────────────────────────────────────────────
function kube(...args) {
  try {
    return execFileSync('kubectl', [`--context=${CTX}`, '-n', NS, ...args],
      { encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (e) { return e.stdout?.trim() ?? ''; }
}

function kubeApply(yamlStr) {
  try {
    return execSync(`kubectl --context=${CTX} -n ${NS} apply -f -`,
      { input: yamlStr, encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (e) { return e.stdout?.trim() ?? ''; }
}

let TOKEN = '';
async function api(endpoint) {
  const r = await fetch(`${API}${endpoint}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  return r.json();
}

async function login() {
  const r = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@admin.com', password: 'admin' }),
  });
  const d = await r.json();
  TOKEN = d.token;
  if (!TOKEN) throw new Error('Login failed — is the backend running?');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Test definitions ───────────────────────────────────────────────────────
// Each test: { name, weight, kind, create(), expected }
// expected: { detected, diagnosis (regex), action, resolved (bool or null=skip) }
const TESTS = [
  // ── Failure scenarios ────────────────────────────────────────────────────
  {
    name: 'OOMKilled deployment',
    weight: 5,
    kind: 'failure',
    pod: 'oom-bare',
    create() {
      kubeApply(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: oom-bare
spec:
  replicas: 1
  selector:
    matchLabels:
      app: oom-bare
  template:
    metadata:
      labels:
        app: oom-bare
    spec:
      containers:
      - name: oom
        image: polinux/stress
        command: ["stress", "--vm", "1", "--vm-bytes", "128M"]
        resources:
          limits:
            memory: "4Mi"`);
    },
    expected: { detected: true, diagnosis: /oom|out.of.memory|memory.limit|kill/i, action: 'increase_memory', altActions: ['ESCALATED'] },
  },
  {
    name: 'OOMKilled deployment (nginx)',
    weight: 5,
    kind: 'failure',
    pod: 'oom-deploy',
    create() {
      kubeApply(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: oom-deploy
spec:
  replicas: 1
  selector:
    matchLabels:
      app: oom-deploy
  template:
    metadata:
      labels:
        app: oom-deploy
    spec:
      containers:
      - name: web
        image: nginx
        resources:
          limits:
            memory: "4Mi"`);
    },
    expected: { detected: true, diagnosis: /oom|out.of.memory|memory/i, action: 'increase_memory', altActions: ['ESCALATED'] },
  },
  {
    name: 'ImagePullBackOff',
    weight: 3,
    kind: 'failure',
    pod: 'bad-image',
    create() {
      kubeApply(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: bad-image
spec:
  replicas: 1
  selector:
    matchLabels:
      app: bad-image
  template:
    metadata:
      labels:
        app: bad-image
    spec:
      containers:
      - name: app
        image: fakerepo/doesnotexist:v999`);
    },
    expected: { detected: true, diagnosis: /image|pull|registry|not.found/i, action: 'noop', altActions: ['delete_pod', 'ESCALATED', 'restart'] },
  },
  {
    name: 'Crash bare pod (exit 1)',
    weight: 5,
    kind: 'failure',
    pod: 'crash-bare',
    create() { kube('run', 'crash-bare', '--image=busybox', '--restart=Always', '--', '/bin/false'); },
    expected: { detected: true, diagnosis: /exit|crash|fail|error/i, action: 'noop', altActions: ['ESCALATED', 'delete_pod'] },
  },
  {
    name: 'Exit 127 deployment (binary not found)',
    weight: 5,
    kind: 'failure',
    pod: 'exit127',
    create() {
      kubeApply(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: exit127
spec:
  replicas: 1
  selector:
    matchLabels:
      app: exit127
  template:
    metadata:
      labels:
        app: exit127
    spec:
      containers:
      - name: app
        image: busybox
        command: ["/nonexistent-cmd"]`);
    },
    expected: { detected: true, diagnosis: /not.found|127|binary|command|exec|entrypoint/i, action: 'rollback', altActions: ['delete_pod', 'ESCALATED'] },
  },
  {
    name: 'Bad config deployment (rollback)',
    weight: 8,
    kind: 'failure',
    pod: 'bad-config',
    create() {
      kube('create', 'deployment', 'bad-config', '--image=nginx');
      // Wait for initial rollout
      try { execFileSync('kubectl', [`--context=${CTX}`, '-n', NS, 'rollout', 'status', 'deployment/bad-config', '--timeout=60s'],
        { encoding: 'utf8', timeout: 65000, stdio: 'pipe' }); } catch {}
      // Break it
      kubeApply(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: bad-config
spec:
  replicas: 1
  selector:
    matchLabels:
      app: bad-config
  template:
    metadata:
      labels:
        app: bad-config
    spec:
      containers:
      - name: bad-config
        image: busybox
        command: ["/bin/sh", "-c", "echo BAD_CONFIG && exit 1"]`);
    },
    expected: { detected: true, diagnosis: /config|exit|crash|error|bad/i, action: 'rollback' },
  },
  {
    name: 'CrashLoop deployment (restart)',
    weight: 5,
    kind: 'failure',
    pod: 'crashloop-dep',
    create() {
      kubeApply(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: crashloop-dep
spec:
  replicas: 1
  selector:
    matchLabels:
      app: crashloop-dep
  template:
    metadata:
      labels:
        app: crashloop-dep
    spec:
      containers:
      - name: app
        image: busybox
        command: ["/bin/sh", "-c", "sleep 2 && exit 1"]`);
    },
    expected: { detected: true, diagnosis: /crash|loop|exit|transient|fail/i, action: 'restart', altActions: ['ESCALATED'] },
  },
  {
    name: 'Exit 126 deployment (permission denied)',
    weight: 4,
    kind: 'failure',
    pod: 'exit126',
    create() {
      kubeApply(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: exit126
spec:
  replicas: 1
  selector:
    matchLabels:
      app: exit126
  template:
    metadata:
      labels:
        app: exit126
    spec:
      containers:
      - name: app
        image: busybox
        command: ["/etc/hostname"]`);
    },
    expected: { detected: true, diagnosis: /permission|denied|126|exec|cannot|error/i, action: 'rollback', altActions: ['delete_pod', 'ESCALATED'] },
  },
  {
    name: 'Pending deployment (impossible resources)',
    weight: 3,
    kind: 'failure',
    pod: 'pending-huge',
    create() {
      kubeApply(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: pending-huge
spec:
  replicas: 1
  selector:
    matchLabels:
      app: pending-huge
  template:
    metadata:
      labels:
        app: pending-huge
    spec:
      containers:
      - name: huge
        image: nginx
        resources:
          requests:
            cpu: "100"
            memory: "999Gi"`);
    },
    expected: { detected: true, diagnosis: /pending|schedul|resource|insufficient|unschedul/i, action: 'noop', altActions: ['ESCALATED'] },
  },

  // ── False positive tests (healthy resources) ─────────────────────────────
  {
    name: 'Healthy nginx',
    weight: 8,
    kind: 'healthy',
    pod: 'healthy-nginx',
    create() { kube('run', 'healthy-nginx', '--image=nginx', '--restart=Never'); },
    expected: { detected: false },
  },
  {
    name: 'Healthy redis',
    weight: 8,
    kind: 'healthy',
    pod: 'healthy-redis',
    create() { kube('run', 'healthy-redis', '--image=redis:alpine', '--restart=Never'); },
    expected: { detected: false },
  },
  {
    name: 'Healthy deployment',
    weight: 8,
    kind: 'healthy',
    pod: 'healthy-deploy',
    create() {
      kube('create', 'deployment', 'healthy-deploy', '--image=nginx', '--replicas=1');
      try { execFileSync('kubectl', [`--context=${CTX}`, '-n', NS, 'rollout', 'status', 'deployment/healthy-deploy', '--timeout=90s'],
        { encoding: 'utf8', timeout: 95000, stdio: 'pipe' }); } catch {}
    },
    expected: { detected: false },
  },
  {
    name: 'Healthy busybox (long sleep)',
    weight: 8,
    kind: 'healthy',
    pod: 'healthy-busybox',
    create() { kube('run', 'healthy-busybox', '--image=busybox', '--restart=Never', '--', 'sleep', '3600'); },
    expected: { detected: false },
  },
];

// ── Decision finder ────────────────────────────────────────────────────────
async function findDecision(podName, afterIso) {
  let action = null, rootCause = null, risk = null, status = null;

  // 1. Audit log — reliable for action (only entries after benchmark start)
  try {
    const audit = await api(`/api/audit?limit=500&cluster=${CTX}`);
    for (const d of (audit.docs ?? [])) {
      const ts = d.createdAt ?? d.timestamp ?? '';
      if (ts && ts < afterIso) continue;
      const meta = d.metadata ?? {};
      const key = meta.issueKey ?? d.issueKey ?? '';
      if (key.includes(podName) && key.includes(NS)) {
        const a = meta.action ?? d.action ?? null;
        // For policy-modified entries, prefer the final action over the original
        const finalAction = meta.finalAction ?? a;
        action = finalAction ?? a;
        risk   = meta.risk ?? d.risk ?? null;
        status = d.status ?? null;
        break;
      }
    }
  } catch {}

  // 2. Server logs — get rootCause + action fallback (only recent entries)
  try {
    const logs = await api('/api/logs');
    if (Array.isArray(logs)) {
      for (let i = logs.length - 1; i >= 0; i--) {
        const logTs = logs[i].timestamp ?? '';
        if (logTs && logTs < afterIso) continue;
        const msg = logs[i].message ?? '';
        if (!msg.includes(podName)) continue;

        // Parse raw JSON from [PLANNER] raw: {...}
        if (!rootCause && msg.includes('[PLANNER] raw:')) {
          try {
            const jsonStr = msg.slice(msg.indexOf('{'));
            const parsed = JSON.parse(jsonStr.match(/\{[\s\S]*\}/)?.[0] ?? '{}');
            if (parsed.rootCause) rootCause = parsed.rootCause;
            if (!action && parsed.action) action = parsed.action;
            if (!risk && parsed.risk) risk = parsed.risk;
          } catch {}
        }

        // Parse formatted rootCause line
        if (!rootCause && msg.includes('[PLANNER]') && msg.includes('rootCause')) {
          const m = msg.match(/rootCause\s*:\s*(.+)/);
          if (m) rootCause = m[1].trim();
        }

        // Parse formatted action line
        if (!action && msg.includes('[PLANNER]') && msg.includes('action')) {
          const m = msg.match(/action\s*[:=]\s*(\S+)/);
          if (m) action = m[1];
          const rM = msg.match(/risk\s*[:=]\s*(\S+)/);
          if (rM && !risk) risk = rM[1];
        }
      }
    }
  } catch {}

  if (action) return { action, rootCause, risk, status };

  // 3. Escalations fallback
  try {
    const escs = await api('/api/escalations');
    if (Array.isArray(escs)) {
      for (const e of escs) {
        if ((e.issueKey ?? '').includes(podName) && (e.issueKey ?? '').includes(NS)) {
          return { action: 'ESCALATED', rootCause: e.rca?.suspected_cause ?? null, risk: null, status: e.status };
        }
      }
    }
  } catch {}

  return null;
}

// ── Check pod resolution ───────────────────────────────────────────────────
function checkResolved(podName) {
  try {
    // Try exact pod name first (bare pods)
    const phase = kube('get', 'pod', podName, '-o', 'jsonpath={.status.phase}');
    if (phase === 'Running') return true;
  } catch {}
  try {
    // Try deployment pods (label selector)
    const out = kube('get', 'pods', '-l', `app=${podName}`, '-o',
      'jsonpath={range .items[*]}{.status.phase}{" "}{end}');
    if (out.includes('Running')) return true;
  } catch {}
  try {
    // Try run= label (kubectl run creates this)
    const out = kube('get', 'pods', '-l', `run=${podName}`, '-o',
      'jsonpath={range .items[*]}{.status.phase}{" "}{end}');
    if (out.includes('Running')) return true;
  } catch {}
  return false;
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${C.B}${C.b}━━━ KubePilot Agent Benchmark ━━━${C.n}`);
  console.log(`${C.d}cluster=${CTX}  ns=${NS}  timeout=${TIMEOUT}s  stress=${STRESS}${C.n}\n`);

  await login();
  console.log(`${C.g}  OK${C.n} Logged in\n`);

  // Setup namespace
  try { execFileSync('kubectl', [`--context=${CTX}`, 'create', 'namespace', NS],
    { encoding: 'utf8', timeout: 10000, stdio: 'pipe' }); } catch {}

  const activeTests = STRESS ? TESTS : TESTS;
  const startTimes = {};
  const results = [];
  const benchStartIso = new Date().toISOString();
  const benchStartMs  = Date.now();

  // Create all test workloads
  console.log(`${C.b}[create]${C.n} Deploying ${activeTests.length} test workloads...`);
  for (const t of activeTests) {
    process.stdout.write(`  ${C.b}*${C.n} ${t.name}...`);
    startTimes[t.pod] = Date.now();
    try {
      t.create();
      console.log(` ${C.g}created${C.n}`);
    } catch (e) {
      console.log(` ${C.r}failed: ${e.message}${C.n}`);
    }
  }

  // Poll for decisions
  console.log(`\n${C.b}[poll]${C.n} Waiting for agent decisions (max ${TIMEOUT}s)...\n`);

  const decisions = {};
  const detectionTimes = {};
  let elapsed = 0;
  const failureTests = activeTests.filter(t => t.expected.detected !== false);
  const healthyTests = activeTests.filter(t => t.expected.detected === false);

  while (elapsed < TIMEOUT) {
    await sleep(POLL * 1000);
    elapsed += POLL;

    let detectedCount = 0;
    for (const t of activeTests) {
      if (decisions[t.pod]) { detectedCount++; continue; }
      const dec = await findDecision(t.pod, benchStartIso);
      if (dec) {
        decisions[t.pod] = dec;
        detectionTimes[t.pod] = Date.now() - startTimes[t.pod];
        detectedCount++;
      }
    }

    const failureDetected = failureTests.filter(t => decisions[t.pod]).length;
    process.stdout.write(`\r  ${elapsed}s — failures: ${failureDetected}/${failureTests.length} detected, healthy: checking... `);

    // Stop early if all failures detected (healthy pods should stay undetected)
    if (failureDetected >= failureTests.length) {
      // Wait one more cycle to catch false positives on healthy pods
      await sleep(POLL * 1000);
      elapsed += POLL;
      for (const t of healthyTests) {
        if (!decisions[t.pod]) {
          const dec = await findDecision(t.pod, benchStartIso);
          if (dec) {
            decisions[t.pod] = dec;
            detectionTimes[t.pod] = Date.now() - startTimes[t.pod];
          }
        }
      }
      break;
    }
  }
  console.log('\n');

  // ── Score each test ────────────────────────────────────────────────────
  console.log(`${C.B}${C.b}━━━ Results ━━━${C.n}\n`);

  let totalWeight = 0, earnedWeight = 0;
  const latencies = [];
  let falsePositives = 0, trueNegatives = 0;
  let correctDiag = 0, totalDiag = 0;
  let correctAction = 0, totalAction = 0;
  let resolved = 0, totalResolution = 0;

  for (const t of activeTests) {
    const dec = decisions[t.pod] ?? null;
    const exp = t.expected;
    const latencyMs = detectionTimes[t.pod] ?? null;
    const latencySec = latencyMs ? (latencyMs / 1000).toFixed(1) : null;

    const r = {
      name: t.name,
      pod: t.pod,
      kind: t.kind,
      weight: t.weight,
      detection: { pass: false, detail: '' },
      diagnosis: { pass: false, detail: '' },
      action:    { pass: false, detail: '' },
      resolution:{ pass: false, detail: '', skipped: true },
      latencyMs,
      earned: 0,
    };

    if (t.kind === 'healthy') {
      // False positive test: PASS = not detected
      if (!dec) {
        r.detection = { pass: true, detail: 'correctly ignored' };
        r.diagnosis = { pass: true, detail: 'n/a' };
        r.action    = { pass: true, detail: 'no action (correct)' };
        r.earned = t.weight;
        trueNegatives++;
      } else {
        r.detection = { pass: false, detail: `FALSE POSITIVE — agent acted: ${dec.action}` };
        falsePositives++;
      }
    } else {
      // Failure test: score detection, diagnosis, action, resolution
      // Detection (25% of weight)
      if (dec) {
        r.detection = { pass: true, detail: `detected in ${latencySec}s` };
        r.earned += t.weight * 0.25;
        if (latencyMs) latencies.push(latencyMs);
      } else {
        r.detection = { pass: false, detail: 'not detected' };
      }

      // Diagnosis (25% of weight)
      totalDiag++;
      if (dec?.rootCause && exp.diagnosis) {
        if (exp.diagnosis.test(dec.rootCause)) {
          r.diagnosis = { pass: true, detail: dec.rootCause.slice(0, 60) };
          r.earned += t.weight * 0.25;
          correctDiag++;
        } else {
          r.diagnosis = { pass: false, detail: `"${(dec.rootCause ?? '').slice(0, 60)}" — expected match: ${exp.diagnosis}` };
        }
      } else if (dec && !dec.rootCause) {
        r.diagnosis = { pass: false, detail: 'no rootCause in response' };
      } else {
        r.diagnosis = { pass: false, detail: 'not evaluated (no detection)' };
      }

      // Action (35% of weight)
      totalAction++;
      if (dec?.action) {
        const isExact = dec.action === exp.action;
        const isAlt   = !isExact && (exp.altActions ?? []).includes(dec.action);
        if (isExact) {
          r.action = { pass: true, detail: dec.action };
          r.earned += t.weight * 0.35;
          correctAction++;
        } else if (isAlt) {
          r.action = { pass: true, detail: `${dec.action} (acceptable alt)` };
          r.earned += t.weight * 0.20;
          correctAction++;
        } else {
          r.action = { pass: false, detail: `${dec.action} (expected: ${exp.action})` };
        }
      } else {
        r.action = { pass: false, detail: 'no action (not detected)' };
      }

      // Resolution (15% of weight) — check if pod is healthy after fix
      if (dec?.action && dec.action !== 'noop' && dec.action !== 'ESCALATED') {
        totalResolution++;
        const isResolved = checkResolved(t.pod);
        r.resolution = { pass: isResolved, detail: isResolved ? 'pod running' : 'still failing', skipped: false };
        if (isResolved) { r.earned += t.weight * 0.15; resolved++; }
      }
    }

    totalWeight += t.weight;
    earnedWeight += r.earned;
    results.push(r);

    // Print result
    const icon = r.detection.pass && r.action.pass ? `${C.g}PASS` :
                 !r.detection.pass && t.kind === 'failure' ? `${C.y}SKIP` :
                 r.detection.pass && !r.action.pass ? `${C.r}FAIL` :
                 !r.detection.pass && t.kind === 'healthy' ? `${C.r}FAIL` : `${C.r}FAIL`;
    console.log(`  ${icon}${C.n}  ${C.B}${t.name}${C.n} ${C.d}(${t.pod}, weight=${t.weight})${C.n}`);
    console.log(`       Detection:  ${r.detection.pass ? C.g+'PASS' : C.r+'FAIL'}${C.n}  ${r.detection.detail}`);
    if (t.kind !== 'healthy') {
      console.log(`       Diagnosis:  ${r.diagnosis.pass ? C.g+'PASS' : C.r+'FAIL'}${C.n}  ${r.diagnosis.detail}`);
      console.log(`       Action:     ${r.action.pass ? C.g+'PASS' : C.r+'FAIL'}${C.n}  ${r.action.detail}`);
      if (!r.resolution.skipped)
        console.log(`       Resolution: ${r.resolution.pass ? C.g+'PASS' : C.r+'FAIL'}${C.n}  ${r.resolution.detail}`);
    }
    if (latencySec) console.log(`       Latency:    ${latencySec}s`);
    console.log('');
  }

  // ── Metrics ──────────────────────────────────────────────────────────────
  const weightedScore = totalWeight > 0 ? ((earnedWeight / totalWeight) * 100).toFixed(1) : 0;
  const avgLatency = latencies.length ? (latencies.reduce((a,b)=>a+b,0) / latencies.length / 1000).toFixed(1) : 'n/a';
  const p95Latency = latencies.length >= 2
    ? (latencies.sort((a,b)=>a-b)[Math.floor(latencies.length * 0.95)] / 1000).toFixed(1)
    : avgLatency;
  const fpRate = (healthyTests.length > 0)
    ? ((falsePositives / healthyTests.length) * 100).toFixed(1) : '0.0';

  console.log(`${C.B}${C.b}━━━ Metrics ━━━${C.n}\n`);
  console.log(`  Weighted Score:       ${C.B}${weightedScore}%${C.n}`);
  console.log(`  Detection Accuracy:   ${results.filter(r=>r.detection.pass).length}/${activeTests.length}`);
  console.log(`  Diagnosis Accuracy:   ${correctDiag}/${totalDiag}`);
  console.log(`  Action Accuracy:      ${correctAction}/${totalAction}`);
  console.log(`  Resolution Rate:      ${resolved}/${totalResolution || 'n/a'}`);
  console.log(`  False Positive Rate:  ${C.B}${fpRate}%${C.n} (${falsePositives}/${healthyTests.length})`);
  console.log(`  Avg Decision Time:    ${avgLatency}s`);
  console.log(`  P95 Decision Time:    ${p95Latency}s`);
  console.log('');

  // ── Save results ─────────────────────────────────────────────────────────
  if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });

  let commit = 'unknown';
  try { commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim(); } catch {}

  const report = {
    date:        new Date().toISOString(),
    commit,
    cluster:     CTX,
    model:       process.env.OPENAI_MODEL ?? 'unknown',
    timeout:     TIMEOUT,
    metrics: {
      weightedScore:    parseFloat(weightedScore),
      detectionAcc:     results.filter(r=>r.detection.pass).length / activeTests.length,
      diagnosisAcc:     totalDiag > 0 ? correctDiag / totalDiag : null,
      actionAcc:        totalAction > 0 ? correctAction / totalAction : null,
      resolutionRate:   totalResolution > 0 ? resolved / totalResolution : null,
      falsePositiveRate: healthyTests.length > 0 ? falsePositives / healthyTests.length : 0,
      avgLatencyMs:     latencies.length ? latencies.reduce((a,b)=>a+b,0) / latencies.length : null,
      p95LatencyMs:     latencies.length >= 2 ? latencies.sort((a,b)=>a-b)[Math.floor(latencies.length * 0.95)] : null,
    },
    tests: results.map(r => ({
      name: r.name, pod: r.pod, kind: r.kind, weight: r.weight, earned: r.earned,
      detection: r.detection.pass, diagnosis: r.diagnosis.pass, action: r.action.pass,
      resolution: r.resolution.skipped ? null : r.resolution.pass,
      latencyMs: r.latencyMs, actionDetail: r.action.detail,
    })),
  };

  const filename = `bench-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
  fs.writeFileSync(path.join(RESULTS_DIR, filename), JSON.stringify(report, null, 2));
  console.log(`${C.d}Report saved: benchmark/results/${filename}${C.n}`);

  // ── Regression check ─────────────────────────────────────────────────────
  const prevFiles = fs.existsSync(RESULTS_DIR)
    ? fs.readdirSync(RESULTS_DIR).filter(f => f.startsWith('bench-') && f.endsWith('.json')).sort()
    : [];
  if (prevFiles.length >= 2) {
    const prev = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, prevFiles[prevFiles.length - 2])));
    const diff = report.metrics.weightedScore - prev.metrics.weightedScore;
    if (diff < -5) {
      console.log(`\n  ${C.r}${C.B}REGRESSION${C.n} ${C.r}Score dropped ${diff.toFixed(1)}% vs previous run (${prev.metrics.weightedScore}% → ${report.metrics.weightedScore}%)${C.n}`);
    } else if (diff > 0) {
      console.log(`\n  ${C.g}Improvement: +${diff.toFixed(1)}% vs previous run${C.n}`);
    }
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────
  console.log(`\n${C.b}[cleanup]${C.n} Removing test namespace...`);
  try { execFileSync('kubectl', [`--context=${CTX}`, 'delete', 'namespace', NS, '--ignore-not-found', '--wait=false'],
    { encoding: 'utf8', timeout: 15000, stdio: 'pipe' }); } catch {}

  console.log(`\n${C.d}Done. Press Ctrl+C to exit.${C.n}\n`);

  // Keep alive on Windows so the terminal doesn't close
  if (process.platform === 'win32') {
    await new Promise(() => {});
  }
}

main().catch(err => {
  console.error(`\n${C.r}Fatal: ${err.message}${C.n}`);
  if (process.platform === 'win32') {
    process.stdin.resume();
    process.stdin.on('data', () => process.exit(1));
  } else {
    process.exit(1);
  }
});
