#!/usr/bin/env node
// =============================================================================
// noop-repro.js — focused repro for the ~13 agent-benchmark-advanced1.js cases that
// originally scored exactly 0.25×weight (detected, but Planner returned an empty-
// command/"noop" step where restart/rollback/increase_memory was expected). Runs ONLY
// those cases, not the full 33-test suite, and persists the COMPLETE per-stage
// pipeline trace for every workflow ATTEMPT to disk so you can tell offline whether
// noop was a deliberate Planner decision or a fallback (low confidence / iteration
// cap / LLM error / exception).
//
// ── Issue-scoped verdicts (2026-09-11 rewrite) ──────────────────────────────────
// The verdict comes from the ISSUE's cumulative status via GET /api/issues (backed by
// the IssueTracker Mongo collection, src/db/models/history.js), NOT from the single
// most-recent workflow via GET /api/live-workflows. Confirmed root cause of the
// original mis-scoring: liveWorkflowStore REPLACES an incident's step history whenever
// a new workflow_id appears for the same resource (src/monitoring/liveWorkflowStore.js:46),
// so /api/live-workflows can only ever show the latest attempt. But 'failed' is NOT
// terminal in KubePilot — it's relabeled "Retrying" in the dashboard
// (dashboard-ui/src/constants/index.js:28), triggers a ~45s cooldown, and the
// orchestrator dispatches a NEW workflow (new workflowId) against the SAME still-open
// IssueTracker document (src/api/issueTrackerStore.js:72/110 — keyed by issueKey, not
// workflowId) until one attempt sets status 'fixed' or 'escalated'. The old version of
// this script broke its poll loop on the first workflow's `finishedAt`, so a pod whose
// FIRST attempt no-op'd but SECOND attempt fixed it was scored "failed" — exactly what
// the dashboard's cumulative view would correctly show as "Fixed". This version polls
// until the ISSUE itself settles (status ∈ {fixed, escalated} — the only two terminal
// values per history.js's own documented lifecycle comment), while still recording
// every individual workflow attempt's full stage trace along the way (keyed by
// workflowId, so a later attempt never overwrites an earlier one in the OUTPUT, even
// though it does in liveWorkflowStore itself).
//
// issueKey format is `${clusterName}/${namespace}/${deployment|podName}` — confirmed
// from src/orchestrator/issueKey.js, NOT "type:target:namespace" as one might assume;
// there's no "type" segment at all. There's no GET-by-issueKey route, so this fetches
// GET /api/issues?cluster=<name>&limit=100 (paginated) and filters client-side.
//
// Fixture bodies below are copied verbatim from agent-benchmark-advanced1.js's TESTS
// array (crashloop-dep, bad-config, cascade-db, cascade-app, rollchain, flapper,
// init-crash, multi-crash, partial-fail, exit137, exit127-dep, exit126-dep, iso-crash
// ×2) rather than imported from it — that file executes its whole suite as a side
// effect of being loaded (`main().catch(...)` at the bottom, which even calls
// process.exit(1) on a login failure), so importing it would run all 33 tests and
// could kill this process outright. Copying ~13 short kubectl-apply blocks is lower
// risk than restructuring an existing, working file to make it import-safe.
//
// Relies on two DIAGNOSTIC-marked additions elsewhere (src/agents/planner.js,
// src/orchestrator/graph.js's plannerNode) that expose the Planner's internal
// stopReason and exact LLM input via the existing IncidentTracer -> liveWorkflowStore
// -> /api/live-workflows pipe — see those files' "DIAGNOSTIC (noop-repro..." comments
// to find/remove them later. No planner/investigator/orchestrator LOGIC is touched —
// this file only reads from a different, more correct source and waits for a different,
// more correct stop condition.
//
// Usage:
//   node benchmark/noop-repro.js
//   node benchmark/noop-repro.js --context=minikube --ns=noop-repro --caseTimeout=900
//   node benchmark/noop-repro.js --cluster=minikube   # if clusterName in clusters.yaml
//                                                      # differs from --context
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

const CTX         = ARGS.context     || 'minikube';
const API         = ARGS.api         || 'http://localhost:3001';
// §Fix-StaleEscalation (2026-09-11) — issueKey (`${cluster}/${namespace}/${pod}`) is the
// dedup key escalationStore/hasActiveEscalation key off, and escalations survive process
// restarts (restored from Mongo) and outlive this script's own end-of-run namespace
// cleanup below — so re-running against a fixed "noop-repro" namespace name reuses the
// exact same issueKeys every time. Confirmed live: rollchain escalated in a prior run,
// never got acknowledged, and the next run's hasActiveEscalation() check silently
// suppressed it before it was ever dispatched (0 attempts, "settled" in 5.8s on stale
// state). RUN_SUFFIX makes every run's namespace — and therefore every issueKey — unique,
// so a fresh run can never collide with a prior one's escalation/cooldown/dedup state.
// Only applied when --ns/--ns for the isolation cases isn't explicitly overridden, so a
// deliberate re-run against a fixed namespace (e.g. to inspect leftover state) still works.
const RUN_SUFFIX   = ARGS.runSuffix || Date.now().toString(36);
const NS          = ARGS.ns          || `noop-repro-${RUN_SUFFIX}`;
// The "name" a cluster is registered under in clusters.yaml — usually equal to CTX
// (true for a plain "minikube" entry, same assumption agent-benchmark-advanced1.js's
// own HPA_CLUSTER makes), override with --cluster= if yours differs. issueKey() prefixes
// on this name, not the kubectl context string, so getting it wrong means every
// /api/issues lookup below silently finds nothing.
const CLUSTER_NAME = ARGS.cluster || CTX;
// Per-case safety cap — raised from the original 300s: an issue that retries (cooldown
// ~45s per attempt, up to MAX_FIX_ATTEMPTS=3 in graph.js before escalating, each attempt
// itself taking anywhere from ~10s to 2+ minutes of LLM time) can legitimately take
// several minutes to actually settle. This is a safety net for a genuinely stuck issue,
// not the expected run length — see isSettled() below for the real stop condition.
const CASE_TIMEOUT_S = parseInt(ARGS.caseTimeout || '900', 10);
const POLL_S       = parseInt(ARGS.poll || '5', 10);
// Independent, kubectl-sourced ground truth alongside the API-based issue/workflow
// polling above — the pipeline's own account (IssueTracker status, workflow outcome)
// is what decides the verdict, but this is a second, unrelated source that can't be
// wrong about what the CLUSTER actually thinks the pod's state is. Every 30s by
// default, not tied to POLL_S, since there's no reason to hit the API and kubectl on
// the same cadence.
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
// Explicit timeout — a bare `fetch()` with no signal can hang indefinitely on a dead
// connection (confirmed live, 2026-09-11: the KubePilot server under nodemon restarted
// mid-run — triggered by this very script writing its own .json result files into a
// nodemon-watched directory, see nodemon.json's new ignore list — and every poll after
// that silently hung forever on the stale connection instead of erroring so the
// existing try/catch in fetchLiveWorkflows()/fetchIssueByKey() could recover on the
// next tick). 15s is generous for a local API call; a genuinely dead server should
// fail fast, not freeze the whole case.
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

// Same substring-match philosophy as agent-benchmark-advanced1.js's matchIncident() —
// t.pod is usually the Deployment name, resourceFromIssue() may carry that or the
// literal generated pod name depending on how far the incident got.
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

// No GET-by-issueKey route exists (issues.routes.js only filters by status/cluster) —
// issueTrackerStore.list() sorts by updatedAt desc, so an issue with any recent
// activity surfaces on an early page; paginate a few pages as a safety margin rather
// than assuming page 1 alone is enough on a busy cluster.
async function fetchIssueByKey(issueKey) {
  for (let page = 1; page <= 5; page++) {
    let d;
    try { d = await api(`/api/issues?cluster=${encodeURIComponent(CLUSTER_NAME)}&limit=100&page=${page}`); }
    catch { return null; }
    const items = Array.isArray(d.items) ? d.items : [];
    const found = items.find(i => i.issueKey === issueKey);
    if (found) return found;
    if (items.length < 100) break; // last page reached
  }
  return null;
}

// The only two terminal values per history.js's own documented status lifecycle
// comment: "detected -> investigating -> awaiting_approval -> approved ->
// (blocked|skipped|failed|success)* -> fixed / -> escalated" — everything else,
//'failed' (displayed as "Retrying") included, is explicitly repeatable.
function isSettled(status) {
  return status === 'fixed' || status === 'escalated';
}

// Ground-truth state of EVERY pod in the namespace, straight from the cluster,
// independent of anything the pipeline/dashboard reports. Runs exactly:
//   kubectl --context=<CTX> -n <namespace> get pods -o json
// No label filter — the fixture's own pod is flagged via `isTarget` (matched by the
// `app` label, since a real fix like "rollout restart" deletes the old pod object and
// creates a new one with a different generated name, so pinning to a fixed pod name
// would silently go stale mid-run), but every OTHER pod in the namespace comes back
// too, in case something unexpected is happening alongside the fixture under test.
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

// =============================================================================
// CASES — copied verbatim from agent-benchmark-advanced1.js's TESTS array (see file
// header). Only the 13 pods that score 0.25×weight in the full advanced run.
// =============================================================================
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

// Groups incident.steps (chronological) by component into arrays — a re-diagnose loop
// can visit investigator/planner more than once per workflow, and executor emits two
// entries per step (per-step + the final "ready state" summary) — arrays keep all of it
// rather than silently keeping only the last one.
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

// A plan is only genuinely "noop" if EVERY step ended up command-less — graph.js's
// routeAfterPlanner (`allNoop ? 'reflexion' : 'guardian'`) skips guardian/policy/
// executor entirely in exactly that case, so their absence here is a reliable
// cross-check independent of the diagnostic stopReason label. Matters because these
// cases are flaky-benchmark reruns, not guaranteed-noop fixtures — a re-run can
// legitimately produce a real, non-noop plan, and mislabeling that as "deliberate noop"
// would defeat the point of this investigation.
function wasAllNoop(stages) {
  const hadPlanner = (stages.planner ?? []).length > 0;
  const reachedExecution = (stages.guardian ?? []).length > 0 || (stages.policy ?? []).length > 0 || (stages.executor ?? []).length > 0;
  return hadPlanner && !reachedExecution;
}

function deriveNoopOrigin(stages) {
  const plannerEntries = stages.planner ?? [];
  if (plannerEntries.length === 0) return 'unknown'; // planner never ran at all (e.g. capped before reaching it)
  if (!wasAllNoop(stages)) return 'not-noop-this-run'; // planner produced a real, actionable plan this time
  const last = plannerEntries[plannerEntries.length - 1];
  const reason = last?.output?.noop_origin ?? null;
  if (reason === 'submitted') return 'deliberate';
  if (reason) return `fallback:${reason}`;
  return 'unknown'; // no planner step recorded at all, or ran before instrumentation existed
}

// Per-ATTEMPT classification color (noop_origin) — unchanged from before, still used
// inside each attempt record for the Planner investigation this script exists for.
function colorFor(origin) {
  if (origin === 'deliberate') return C.g;
  if (origin === 'not-noop-this-run') return C.b;
  if (origin.startsWith('fallback')) return C.y;
  return C.r; // 'unknown'
}

// Per-ISSUE verdict color — the new, issue-scoped top-level result for a case.
function verdictColor(verdict) {
  if (verdict === 'resolved') return C.g;
  if (verdict === 'escalated') return C.y;
  return C.r; // 'unsettled:timeout'
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

// Builds one ATTEMPT record (one workflowId's full stage trace) from a /api/live-
// workflows incident — same shape the old single-attempt version produced, just now
// one of potentially several kept per case instead of the only one.
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
      // DIAGNOSTIC (Fix 2, 2026-09-11) — graph.js's plannerNode now surfaces these
      // alongside the existing diagnostic fields (see graph.js's plannerNode); without
      // reading them here too, a capped run's exact per-turn tool-call sequence never
      // makes it into this script's saved JSON.
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

// label(kase) — every console line in the parallel poller is prefixed with this, since
// with all 14 cases running concurrently their output interleaves; sequential runs
// never needed this disambiguation.
function label(kase) {
  return kase.ns ? `${kase.pod}/${kase.ns}` : kase.pod;
}

// Runs one case's fixture creation ONLY — separated from polling so main() can create
// all 14 up front (matching agent-benchmark-advanced1.js's own create-then-poll shape)
// before launching every case's poller concurrently. kase.create() itself is built on
// execFileSync/synchronous kubectl calls, so these still run one-after-another in quick
// succession (each briefly blocks Node's single event loop) rather than simultaneously
// at the OS level — that's fine, each one only takes a few seconds; the real
// parallelism is in the polling that follows, which is all non-blocking I/O.
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

  // Ground-truth pod state — one baseline snapshot right after create (before the
  // pipeline has even had a chance to react), then one every POD_POLL_S thereafter.
  const podStateHistory = [getPodState(namespace, kase.pod)];
  let podPollAccum = 0;

  // Keyed by workflowId so a LATER attempt updates its own entry (steps still
  // accumulating within that workflow) without ever overwriting an EARLIER attempt's
  // already-recorded entry — the exact thing liveWorkflowStore itself doesn't give us,
  // since it replaces wholesale per new workflow_id (liveWorkflowStore.js:46).
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
      // A genuinely NEW attempt just appeared (not just a fresher snapshot of the one
      // we're already tracking) — worth a live line, since this is exactly the moment
      // the old workflow-scoped test would have started ignoring everything before it.
      const ordinal = attemptsByWorkflowId.size + 1;
      const rec = buildAttemptRecord(incident);
      console.log(`  [${label(kase)}] attempt ${ordinal} (${incident.workflowId.slice(0, 8)}): ${colorFor(rec.noop_origin)}${rec.noop_origin}${C.n}`);
    }
    if (incident?.workflowId) attemptsByWorkflowId.set(incident.workflowId, buildAttemptRecord(incident));

    // The REAL stop condition: the ISSUE's own cumulative status, not this tick's
    // workflow. A transient fetch miss (Mongo hiccup) keeps the last-known record
    // rather than resetting to null, so one bad poll can't un-settle an already-
    // confirmed result.
    issueRecord = await fetchIssueByKey(issueKey) ?? issueRecord;
    if (issueRecord && isSettled(issueRecord.status)) { settled = true; break; }
  }

  // One last snapshot at the moment we actually stop watching — whether that's because
  // the issue settled or the safety cap hit — so the pod-state timeline always ends at
  // the same moment the verdict was decided, not up to POD_POLL_S seconds earlier.
  podStateHistory.push(getPodState(namespace, kase.pod));

  const attempts = [...attemptsByWorkflowId.values()]; // insertion order = chronological
  const finalStatus = issueRecord?.status ?? 'unknown';
  const verdict = !settled ? 'unsettled:timeout' : finalStatus === 'fixed' ? 'resolved' : 'escalated';

  // The exact thing this rewrite exists to catch: an early attempt that no-op'd/failed,
  // superseded by a later one that actually resolved the issue.
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
    podStateHistory, // independent kubectl ground truth, every POD_POLL_S seconds
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

  // Create every fixture up front (same shape as agent-benchmark-advanced1.js's own
  // create-then-poll split), THEN launch all 14 pollers concurrently — they're all
  // non-blocking I/O (sleep/fetch) from this point on, so running them via Promise.all
  // instead of one at a time is what actually cuts the total run time down, rather than
  // waiting up to CASE_TIMEOUT_S for each case in turn.
  console.log(`${C.b}[create]${C.n} Deploying ${CASES.length} fixtures...`);
  for (const kase of CASES) createCase(kase);

  console.log(`\n${C.b}[poll]${C.n} Watching all ${CASES.length} cases in parallel (max ${CASE_TIMEOUT_S}s each)...\n`);
  const results = await Promise.all(CASES.map(kase => pollCase(kase)));

  const summary = results.map(r => {
    const lastAttempt = r.attempts[r.attempts.length - 1] ?? null;
    const lastPodSnapshot = r.podStateHistory[r.podStateHistory.length - 1] ?? null;
    // getPodState() now returns EVERY pod in the namespace — pick out the one that's
    // actually this case's fixture (isTarget), not just the first pod in the list.
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
      // Ground truth, independent of the verdict above — worth comparing against it:
      // a 'resolved' verdict whose pod isn't actually Running/ready would be its own
      // finding.
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
  // Derived from CASES' actual (now RUN_SUFFIX-tagged) namespaces rather than hardcoded,
  // so this can't silently drift from what create() above actually used.
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
