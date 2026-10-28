#!/usr/bin/env node
'use strict';

const { execFileSync, execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const ARGS = process.argv.slice(2).reduce((o, a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  o[k] = v ?? true;
  return o;
}, {});

const CTX         = ARGS.context     || 'minikube';
const API         = ARGS.api         || 'http://localhost:3001';
const RUN_SUFFIX   = ARGS.runSuffix || Date.now().toString(36);
const NS          = ARGS.ns          || `noop-repro-${RUN_SUFFIX}`;
const CLUSTER_NAME = ARGS.cluster || CTX;
const CASE_TIMEOUT_S = parseInt(ARGS.caseTimeout || '900', 10);
const POLL_S       = parseInt(ARGS.poll || '5', 10);
const POD_POLL_S   = parseInt(ARGS.podPoll || '30', 10);
const OUT_DIR      = path.join(__dirname, '..', 'noop-repro-results');

const C = { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', b: '\x1b[34m', d: '\x1b[2m', B: '\x1b[1m', n: '\x1b[0m' };

function kube(...args) {
  try {
    return execFileSync('kubectl', [`--context=${CTX}`, '-n', NS, ...args],
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
function kubeGlobal(...args) {
  try {
    return execFileSync('kubectl', [`--context=${CTX}`, ...args],
      { encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (e) { return e.stdout?.trim() ?? ''; }
}
function waitRollout(name, ns, timeoutSec = 90) {
  try { execFileSync('kubectl', [`--context=${CTX}`, '-n', ns || NS, 'rollout', 'status', `deployment/${name}`, `--timeout=${timeoutSec}s`],
    { encoding: 'utf8', timeout: (timeoutSec + 5) * 1000, stdio: 'pipe' }); } catch {}
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

let TOKEN = '';
// Call the API with a timeout
async function api(endpoint) {
  const r = await fetch(`${API}${endpoint}`, { headers: { Authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(15000) });
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
async function fetchLiveWorkflows() {
  try { const d = await api('/api/live-workflows'); return Array.isArray(d.items) ? d.items : []; }
  catch { return []; }
}

// Find the incident matching the test case
function matchIncident(items, podName, namespace, afterIso) {
  const afterMs = new Date(afterIso).getTime();
  const candidates = items.filter(it => {
    const r = it.resource ?? {};
    if ((r.namespace ?? '') !== namespace) return false;
    if (!r.name || !r.name.includes(podName)) return false;
    const startedMs = new Date(it.startedAt).getTime();
    return Number.isFinite(startedMs) && startedMs >= afterMs;
  });
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  return candidates[0];
}

// Fetch a tracked issue by its issue key
async function fetchIssueByKey(issueKey) {
  for (let page = 1; page <= 5; page++) {
    let d;
    try { d = await api(`/api/issues?cluster=${encodeURIComponent(CLUSTER_NAME)}&limit=100&page=${page}`); }
    catch { return null; }
    const items = Array.isArray(d.items) ? d.items : [];
    const found = items.find(i => i.issueKey === issueKey);
    if (found) return found;
    if (items.length < 100) break;
  }
  return null;
}

// Check if an issue reached a terminal status
function isSettled(status) {
  return status === 'fixed' || status === 'escalated';
}

// Get the state of every pod in the namespace
function getPodState(namespace, appLabel) {
  let raw;
  try {
    raw = execFileSync('kubectl', [`--context=${CTX}`, '-n', namespace, 'get', 'pods', '-o', 'json'],
      { encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    return { ts: new Date().toISOString(), error: e.message, pods: [] };
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { return { ts: new Date().toISOString(), error: `unparseable kubectl output: ${e.message}`, pods: [] }; }

  const pods = (parsed.items ?? []).map(p => {
    const statuses = p.status?.containerStatuses ?? [];
    return {
      name: p.metadata?.name ?? null,
      isTarget: p.metadata?.labels?.app === appLabel,
      phase: p.status?.phase ?? null,
      ready: statuses.length > 0 && statuses.every(cs => cs.ready === true),
      restartCount: statuses.length ? Math.max(...statuses.map(cs => cs.restartCount ?? 0)) : 0,
      containers: statuses.map(cs => ({
        name: cs.name,
        state: cs.state?.waiting ? `waiting:${cs.state.waiting.reason}`
             : cs.state?.terminated ? `terminated:${cs.state.terminated.reason ?? cs.state.terminated.exitCode}`
             : cs.state?.running ? 'running' : 'unknown',
      })),
    };
  });
  return { ts: new Date().toISOString(), error: null, pods };
}

const CASES = [
  {
    name: 'CrashLoop deployment', pod: 'crashloop-dep', category: 'basic',
    expectedAction: 'restart', expectedDiagnosis: '/crash|loop|exit|fail/i',
    create: () => kubeApply(`apiVersion: apps/v1
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
        command: ["/bin/sh","-c","sleep 2 && exit 1"]`),
  },
  {
    name: 'Bad config rollback', pod: 'bad-config', category: 'basic',
    expectedAction: 'rollback', expectedDiagnosis: '/config|exit|crash|error/i',
    create: () => {
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
  },
  {
    name: 'Cascade: broken database', pod: 'cascade-db', category: 'cascade',
    expectedAction: 'restart', expectedDiagnosis: '/crash|exit|fail|db|database/i',
    create: () => kubeApply(`apiVersion: apps/v1
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
        command: ["/bin/sh","-c","echo DB_CRASH && exit 1"]`),
  },
  {
    name: 'Cascade: app depends on broken db', pod: 'cascade-app', category: 'cascade',
    expectedAction: 'restart', expectedDiagnosis: '/crash|connect|exit|fail|depend/i',
    create: () => kubeApply(`apiVersion: apps/v1
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
        command: ["/bin/sh","-c","echo Connecting to cascade-db... && sleep 3 && echo CONN_REFUSED && exit 1"]`),
  },
  {
    name: 'Rollback chain: v3 broken (should rollback)', pod: 'rollchain', category: 'rollback',
    expectedAction: 'rollback', expectedDiagnosis: '/crash|exit|config|image|broken/i',
    create: () => {
      kube('create', 'deployment', 'rollchain', '--image=nginx');
      waitRollout('rollchain');
      kube('set', 'image', 'deployment/rollchain', 'nginx=httpd:alpine');
      waitRollout('rollchain');
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
  },
  {
    name: 'Behavior: flapping pod (alternate crash/run)', pod: 'flapper', category: 'behavior',
    expectedAction: 'restart', expectedDiagnosis: '/crash|exit|fail|flap|intermittent/i',
    create: () => kubeApply(`apiVersion: apps/v1
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
        command: ["/bin/sh","-c","sleep $(( RANDOM % 10 + 5 )) && exit 1"]`),
  },
  {
    name: 'Init: init container crash', pod: 'init-crash', category: 'init',
    expectedAction: 'restart', expectedDiagnosis: '/init|crash|exit|fail/i',
    create: () => kubeApply(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: init-crash
spec:
  replicas: 1
  selector: { matchLabels: { app: init-crash } }
  template:
    metadata: { labels: { app: init-crash } }
    spec:
      initContainers:
      - name: setup
        image: busybox
        command: ["/bin/sh","-c","echo INIT_FAIL && exit 1"]
      containers:
      - name: app
        image: nginx`),
  },
  {
    name: 'Multi: 3-replica crash deployment', pod: 'multi-crash', category: 'multi',
    expectedAction: 'restart', expectedDiagnosis: '/crash|exit|fail/i',
    create: () => kubeApply(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: multi-crash
spec:
  replicas: 3
  selector: { matchLabels: { app: multi-crash } }
  template:
    metadata: { labels: { app: multi-crash } }
    spec:
      containers:
      - name: app
        image: busybox
        command: ["/bin/sh","-c","sleep 3 && exit 1"]`),
  },
  {
    name: 'Multi: mixed healthy + crashing replicas', pod: 'partial-fail', category: 'multi',
    expectedAction: 'rollback', expectedDiagnosis: '/crash|exit|fail|config|broken/i',
    create: () => {
      kube('create', 'deployment', 'partial-fail', '--image=nginx', '--replicas=3');
      waitRollout('partial-fail');
      kubeApply(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: partial-fail
spec:
  replicas: 3
  selector: { matchLabels: { app: partial-fail } }
  template:
    metadata: { labels: { app: partial-fail } }
    spec:
      containers:
      - name: app
        image: busybox
        command: ["/bin/sh","-c","echo BROKEN && exit 1"]`);
    },
  },
  {
    name: 'Exit: code 137 OOM (deployment)', pod: 'exit137', category: 'exitcodes',
    expectedAction: 'increase_memory', expectedDiagnosis: '/oom|memory|137|kill/i',
    create: () => kubeApply(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: exit137
spec:
  replicas: 1
  selector: { matchLabels: { app: exit137 } }
  template:
    metadata: { labels: { app: exit137 } }
    spec:
      containers:
      - name: app
        image: polinux/stress
        command: ["stress","--vm","1","--vm-bytes","128M"]
        resources: { limits: { memory: "4Mi" } }`),
  },
  {
    name: 'Exit: code 127 binary not found (deployment)', pod: 'exit127-dep', category: 'exitcodes',
    expectedAction: 'rollback', expectedDiagnosis: '/not.found|127|binary|command|exec|entrypoint/i',
    create: () => kubeApply(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: exit127-dep
spec:
  replicas: 1
  selector: { matchLabels: { app: exit127-dep } }
  template:
    metadata: { labels: { app: exit127-dep } }
    spec:
      containers:
      - name: app
        image: busybox
        command: ["/nonexistent-binary"]`),
  },
  {
    name: 'Exit: code 126 permission denied (deployment)', pod: 'exit126-dep', category: 'exitcodes',
    expectedAction: 'rollback', expectedDiagnosis: '/permission|denied|126|exec|cannot|error/i',
    create: () => kubeApply(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: exit126-dep
spec:
  replicas: 1
  selector: { matchLabels: { app: exit126-dep } }
  template:
    metadata: { labels: { app: exit126-dep } }
    spec:
      containers:
      - name: app
        image: busybox
        command: ["/etc/hostname"]`),
  },
  {
    name: 'Isolation: crash in ns-alpha', pod: 'iso-crash', ns: `bench-ns-alpha-${RUN_SUFFIX}`, category: 'isolation',
    expectedAction: 'restart', expectedDiagnosis: '/crash|exit|fail/i',
    create: () => {
      kubeGlobal('create', 'namespace', `bench-ns-alpha-${RUN_SUFFIX}`);
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
        command: ["/bin/sh","-c","exit 1"]`, `bench-ns-alpha-${RUN_SUFFIX}`);
    },
  },
  {
    name: 'Isolation: crash in ns-beta', pod: 'iso-crash', ns: `bench-ns-beta-${RUN_SUFFIX}`, category: 'isolation',
    expectedAction: 'restart', expectedDiagnosis: '/crash|exit|fail/i',
    create: () => {
      kubeGlobal('create', 'namespace', `bench-ns-beta-${RUN_SUFFIX}`);
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
        command: ["/bin/sh","-c","exit 1"]`, `bench-ns-beta-${RUN_SUFFIX}`);
    },
  },
];

// Group incident steps by component
function groupStages(steps) {
  const byComponent = {};
  for (const s of steps ?? []) {
    if (!byComponent[s.component]) byComponent[s.component] = [];
    byComponent[s.component].push({
      ts: s.ts, durationMs: s.durationMs ?? null, output: s.output ?? {},
    });
  }
  return byComponent;
}

// Check if every plan step had no command
function wasAllNoop(stages) {
  const hadPlanner = (stages.planner ?? []).length > 0;
  const reachedExecution = (stages.guardian ?? []).length > 0 || (stages.policy ?? []).length > 0 || (stages.executor ?? []).length > 0;
  return hadPlanner && !reachedExecution;
}

function deriveNoopOrigin(stages) {
  const plannerEntries = stages.planner ?? [];
  if (plannerEntries.length === 0) return 'unknown';
  if (!wasAllNoop(stages)) return 'not-noop-this-run';
  const last = plannerEntries[plannerEntries.length - 1];
  const reason = last?.output?.noop_origin ?? null;
  if (reason === 'submitted') return 'deliberate';
  if (reason) return `fallback:${reason}`;
  return 'unknown';
}

// Color for an attempt classification
function colorFor(origin) {
  if (origin === 'deliberate') return C.g;
  if (origin === 'not-noop-this-run') return C.b;
  if (origin.startsWith('fallback')) return C.y;
  return C.r;
}

// Color for an issue verdict
function verdictColor(verdict) {
  if (verdict === 'resolved') return C.g;
  if (verdict === 'escalated') return C.y;
  return C.r;
}

function collectErrors(stages) {
  const errors = [];
  for (const [component, entries] of Object.entries(stages)) {
    for (const e of entries) {
      const msg = e.output?.last_error ?? e.output?.reason ?? e.output?.executionError ?? null;
      if (msg) errors.push({ component, ts: e.ts, message: msg });
    }
  }
  return errors;
}

// Build one attempt record from an incident
function buildAttemptRecord(incident) {
  const stages = groupStages(incident.steps);
  const plannerLast = (stages.planner ?? [])[(stages.planner ?? []).length - 1] ?? null;
  return {
    workflowId: incident.workflowId,
    startedAt: incident.startedAt,
    updatedAt: incident.updatedAt,
    finishedAt: incident.finishedAt ?? null,
    outcome: incident.outcome ?? null,
    noop_origin: deriveNoopOrigin(stages),
    stages: {
      orchestrator: stages.orchestrator ?? [],
      investigator: stages.investigator ?? [],
      planner:      stages.planner ?? [],
      guardian:     stages.guardian ?? [],
      policy:       stages.policy ?? [],
      executor:     stages.executor ?? [],
      reflexion:    stages.reflector ?? [],
    },
    plannerDetail: plannerLast ? {
      noop_origin:      plannerLast.output.noop_origin ?? null,
      planner_input:    plannerLast.output.planner_input ?? null,
      tools_available:  plannerLast.output.tools_available ?? null,
      plan_summary:     plannerLast.output.plan_summary ?? null,
      step_count:       plannerLast.output.step_count ?? null,
      last_error:       plannerLast.output.last_error ?? null,
      tool_call_log:    plannerLast.output.tool_call_log ?? null,
      turns_used:       plannerLast.output.turns_used ?? null,
    } : null,
    retries: {
      investigatorCount: (stages.investigator ?? []).length,
      plannerCount:      (stages.planner ?? []).length,
    },
    errors: collectErrors(stages),
  };
}

// Log prefix for a case
function label(kase) {
  return kase.ns ? `${kase.pod}/${kase.ns}` : kase.pod;
}

// Create the fixtures for one case
function createCase(kase) {
  process.stdout.write(`  ${C.b}*${C.n} ${kase.name} (${label(kase)})...`);
  try { kase.create(); console.log(` ${C.g}created${C.n}`); }
  catch (e) { console.log(` ${C.r}create failed: ${e.message}${C.n}`); }
}

async function pollCase(kase) {
  const namespace = kase.ns || NS;
  const issueKey = `${CLUSTER_NAME}/${namespace}/${kase.pod}`;
  const startIso = new Date().toISOString();
  const t0 = Date.now();

  const podStateHistory = [getPodState(namespace, kase.pod)];
  let podPollAccum = 0;

  const attemptsByWorkflowId = new Map();
  let issueRecord = null;
  let settled = false;
  let elapsed = 0;

  while (elapsed < CASE_TIMEOUT_S) {
    await sleep(POLL_S * 1000);
    elapsed += POLL_S;
    podPollAccum += POLL_S;

    if (podPollAccum >= POD_POLL_S) {
      podPollAccum = 0;
      podStateHistory.push(getPodState(namespace, kase.pod));
    }

    const liveItems = await fetchLiveWorkflows();
    const incident = matchIncident(liveItems, kase.pod, namespace, startIso);
    if (incident?.workflowId && !attemptsByWorkflowId.has(incident.workflowId)) {
      const ordinal = attemptsByWorkflowId.size + 1;
      const rec = buildAttemptRecord(incident);
      console.log(`  [${label(kase)}] attempt ${ordinal} (${incident.workflowId.slice(0, 8)}): ${colorFor(rec.noop_origin)}${rec.noop_origin}${C.n}`);
    }
    if (incident?.workflowId) attemptsByWorkflowId.set(incident.workflowId, buildAttemptRecord(incident));

    issueRecord = await fetchIssueByKey(issueKey) ?? issueRecord;
    if (issueRecord && isSettled(issueRecord.status)) { settled = true; break; }
  }

  podStateHistory.push(getPodState(namespace, kase.pod));

  const attempts = [...attemptsByWorkflowId.values()];
  const finalStatus = issueRecord?.status ?? 'unknown';
  const verdict = !settled ? 'unsettled:timeout' : finalStatus === 'fixed' ? 'resolved' : 'escalated';

  const earlyFailureThenLaterFixed = settled && finalStatus === 'fixed' && attempts.length > 1
    && attempts.slice(0, -1).some(a => a.outcome && a.outcome !== 'fixed');

  const totalLatencyMs = Date.now() - t0;

  const record = {
    case: {
      pod: kase.pod, namespace, category: kase.category, name: kase.name,
      expectedAction: kase.expectedAction, expectedDiagnosisPattern: kase.expectedDiagnosis,
    },
    issueKey,
    issueId: issueRecord?.seq ?? null,
    finalStatus,
    verdict,
    settled,
    workflowIds: attempts.map(a => a.workflowId),
    attempts,
    earlyFailureThenLaterFixed,
    podStateHistory,
    totalLatencyMs,
  };

  console.log(`  [${label(kase)}] ${verdictColor(verdict)}${verdict}${C.n} ${C.d}(status=${finalStatus}, ${attempts.length} attempt(s), ${(totalLatencyMs / 1000).toFixed(1)}s)${C.n}${earlyFailureThenLaterFixed ? `  ${C.y}<- early attempt failed, later one fixed it${C.n}` : ''}`);

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const filename = `${kase.pod}-${kase.ns ? kase.ns + '-' : ''}${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
  fs.writeFileSync(path.join(OUT_DIR, filename), JSON.stringify(record, null, 2));

  return record;
}

async function main() {
  console.log(`\n${C.B}${C.b}━━━ noop-repro: focused Planner-noop investigation ━━━${C.n}`);
  console.log(`${C.d}cluster=${CTX} (issueKey cluster: ${CLUSTER_NAME})  ns=${NS}  caseTimeout=${CASE_TIMEOUT_S}s  cases=${CASES.length}${C.n}`);
  console.log(`${C.d}Verdict is issue-scoped (GET /api/issues) — settles on status fixed/escalated, not the first workflow to finish.${C.n}\n`);

  await login();
  console.log(`${C.g}  OK${C.n} Logged in\n`);

  try { execFileSync('kubectl', [`--context=${CTX}`, 'create', 'namespace', NS], { encoding: 'utf8', timeout: 10000, stdio: 'pipe' }); } catch {}

  console.log(`${C.b}[create]${C.n} Deploying ${CASES.length} fixtures...`);
  for (const kase of CASES) createCase(kase);

  console.log(`\n${C.b}[poll]${C.n} Watching all ${CASES.length} cases in parallel (max ${CASE_TIMEOUT_S}s each)...\n`);
  const results = await Promise.all(CASES.map(kase => pollCase(kase)));

  const summary = results.map(r => {
    const lastAttempt = r.attempts[r.attempts.length - 1] ?? null;
    const lastPodSnapshot = r.podStateHistory[r.podStateHistory.length - 1] ?? null;
    const lastPod = lastPodSnapshot?.pods?.find(p => p.isTarget) ?? null;
    return {
      issueKey: r.issueKey, issueId: r.issueId,
      pod: r.case.pod, ns: r.case.namespace, category: r.case.category,
      finalStatus: r.finalStatus, verdict: r.verdict, settled: r.settled,
      attemptCount: r.workflowIds.length, workflowIds: r.workflowIds,
      earlyFailureThenLaterFixed: r.earlyFailureThenLaterFixed,
      lastAttemptNoopOrigin: lastAttempt?.noop_origin ?? null,
      planner_duration_ms: lastAttempt?.stages.planner[lastAttempt.stages.planner.length - 1]?.durationMs ?? null,
      diagnosis_present: (lastAttempt?.stages.investigator ?? []).some(e => (e.output?.sub_events ?? []).length > 0 || e.output?.root_cause_layer),
      tool_available: !!(lastAttempt?.plannerDetail?.tools_available?.length),
      finalPodPhase: lastPod?.phase ?? null,
      finalPodReady: lastPod?.ready ?? null,
      finalPodRestartCount: lastPod?.restartCount ?? null,
      total_latency_ms: r.totalLatencyMs,
    };
  });

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'noop-repro-summary.json'), JSON.stringify(summary, null, 2));

  console.log(`\n${C.B}${C.b}━━━ Summary (issue-scoped) ━━━${C.n}\n`);
  for (const s of summary) {
    const color = verdictColor(s.verdict);
    const flag = s.earlyFailureThenLaterFixed ? `  ${C.y}<- was mis-scored by the old workflow-scoped test${C.n}` : '';
    const podInfo = `pod=${s.finalPodPhase ?? '—'}${s.finalPodReady === false ? '(not ready)' : ''} restarts=${s.finalPodRestartCount ?? '—'}`;
    console.log(`  ${(s.pod + (s.ns ? `/${s.ns}` : '')).padEnd(28)} ${color}${s.verdict.padEnd(20)}${C.n} status=${String(s.finalStatus).padEnd(11)} attempts=${s.attemptCount} ${podInfo} ${(s.total_latency_ms / 1000).toFixed(1)}s${flag}`);
  }
  const misScoredCount = summary.filter(s => s.earlyFailureThenLaterFixed).length;
  if (misScoredCount > 0) {
    console.log(`\n  ${C.y}${C.B}${misScoredCount} case(s)${C.n}${C.y} would have been mis-scored "failed" by the old workflow-scoped test — see earlyFailureThenLaterFixed in the summary.${C.n}`);
  }
  console.log(`\n${C.d}Per-case files + summary: noop-repro-results/${C.n}`);

  console.log(`\n${C.b}[cleanup]${C.n} Removing test namespaces...`);
  const runNamespaces = [...new Set([NS, ...CASES.map(k => k.ns).filter(Boolean)])];
  for (const n of runNamespaces) {
    try { execFileSync('kubectl', [`--context=${CTX}`, 'delete', 'namespace', n, '--ignore-not-found', '--wait=false'],
      { encoding: 'utf8', timeout: 15000, stdio: 'pipe' }); } catch {}
  }
  console.log(`\n${C.d}Done.${C.n}\n`);
}

main().catch(err => {
  console.error(`\n${C.r}Fatal: ${err.message}${C.n}`);
  process.exit(1);
});
