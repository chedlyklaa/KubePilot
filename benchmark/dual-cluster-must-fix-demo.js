#!/usr/bin/env node
// =============================================================================
// dual-cluster-must-fix-demo.js — 10 broken pods, split across the two live dev
// clusters (cluster3 + minikube), EVERY ONE deliberately chosen to be something
// the pipeline CAN and SHOULD fix with a real, well-defined kubectl-only action
// (expectedFixable is always true here — unlike dual-cluster-fix-rate-demo.js,
// which this file replaces, there is no escalate-only control group). The same
// 5 issue types are reproduced on BOTH clusters (oom / bad-rollout / bad-node-
// selector / oversized-request / over-provisioned-replicas) so a result also
// answers "is the pipeline consistent across clusters for the same fault", not
// just "did it fix pod X".
//
// Why these 5 issue types specifically: each one is either a scenario the
// pipeline has DIRECTLY been observed fixing in prior live runs (oom limit
// raise, rollback to a real prior-good revision), or a scenario this session
// added evidence/verification support for (bad-nodeSelector — was blocked by a
// policy-sanitizer false positive on the quoted JSON patch, fixed in
// src/policy/policyEngine.js; oversized-request / over-provisioned-replicas —
// the Planner previously had no real node-capacity evidence to size these
// correctly, fixed in src/agents/planner.js's _gatherNodeCapacity /
// _capacityAdvisoryForScale). Running all 5 here is a direct regression check
// on that work, not just a general capability demo.
//
// §Fix-SilentSetupFailure (2026-09-16) — the predecessor script's kubeApply()/
// kube() helpers swallowed every kubectl error and returned stdout ('') instead
// of throwing. On 2026-09-16 this produced a run where 3 pods that were supposed
// to stay broken showed up "healthy" with zero investigation trace — the most
// likely explanation, confirmed by re-reading that code, is that applying the
// broken fixture silently failed and the check then read whatever (unrelated,
// already-healthy) state was already there. This file's kubectl helpers THROW on
// a real failure, and every test's create() is wrapped so a setup failure is
// recorded as its own explicit `setupFailed` outcome — never silently
// indistinguishable from "the agent already fixed it".
//
// Every test is scored on THREE independent signals, all stored/rendered so a
// surprising result can be explained instead of guessed at:
//   1. Detection      — did the pipeline open an incident for THIS EXACT pod?
//   2. Pipeline's own verdict — the executor's own `ready` field from its last
//      per-issue summary trace (src/orchestrator/graph.js's _issueResolution/
//      verifyResourceHealthy) — what the AGENT believes happened.
//   3. Live re-check   — this script's own kubectl re-read of the Deployment's
//      status.readyReplicas/updatedReplicas vs spec.replicas, rechecked again
//      ~20s later for stability — independent ground truth, not the agent's word.
//   Plus the FULL pipeline trace (every investigator/planner/guardian/policy/
//   executor/reflector step, every retry attempt) is saved per pod.
//
// Exact-pod detection safety:
//   1. Every deployment name is globally unique (c3-/mk- prefixed).
//   2. Each test lives in its own per-cluster namespace (demo-fix-c3 /
//      demo-fix-mk) — FRESH names never used by any earlier benchmark, so a
//      previous run's leftover state can never be mistaken for this run's.
//   3. matchIncident() filters on incident.resource.clusterName too, so a
//      decision is only ever credited to a test if clusterName+namespace+name
//      all line up, not just name.
//   4. A benchmark-start timestamp excludes any leftover incident from a
//      previous run (liveWorkflowStore keeps a finished incident visible for
//      30 min).
//
// Usage:
//   node benchmark/dual-cluster-must-fix-demo.js
//   node benchmark/dual-cluster-must-fix-demo.js --api=http://localhost:3001 --timeout=3600
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

const API = ARGS.api ?? 'http://localhost:3001';
// Safety cap only — the real stop condition is Short Memory going idle (see the
// poll loop in main()), same reasoning as agent-benchmark-advanced1.js.
const TIMEOUT            = parseInt(ARGS.timeout   ?? '3600', 10);
const POLL               = parseInt(ARGS.poll      ?? '10', 10);
const IDLE_CONFIRM_TICKS = parseInt(ARGS.idleTicks ?? '3', 10);
// How long to wait between the two "still healthy" stability reads on a
// Deployment that reached readyReplicas===replicas, so a flapping workload
// that's briefly ready then crashes again isn't miscounted as a real fix.
const STABILITY_GAP_MS = parseInt(ARGS.stabilityGap ?? '20000', 10);
// checkReallyFixed() polls for up to this long rather than checking live state
// once — detection fires as soon as the investigator step lands, long before the
// executor finishes, so a real fix that just takes a while must not be
// misreported as a miss (this was confirmed live on the predecessor script,
// 2026-09-14: a pod that genuinely got fixed still read "not fixed" under a
// one-shot check taken too early).
const FIX_CHECK_TIMEOUT_MS = parseInt(ARGS.fixCheckTimeout ?? '300000', 10); // 5 min per pod
const FIX_CHECK_POLL_MS    = parseInt(ARGS.fixCheckPoll    ?? '15000', 10);

const RESULTS_DIR = path.join(__dirname, 'results');

const C = {
  r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', b: '\x1b[34m',
  c: '\x1b[36m', d: '\x1b[2m', B: '\x1b[1m', n: '\x1b[0m',
};

// =============================================================================
// KUBECTL HELPERS — every call is explicitly context+namespace scoped, since
// this script talks to two clusters at once. §Fix-SilentSetupFailure (see file
// header): kube()/kubeApply() THROW on a real kubectl failure instead of
// swallowing it — a fixture that fails to apply must never be silently
// mistaken for "the agent already fixed it". waitRollout() alone stays
// best-effort: it is only ever a courtesy pause before applying a second,
// deliberately-broken revision, never something a test's correctness depends on.
// =============================================================================
function kube(context, ns, ...args) {
  try {
    return execFileSync('kubectl', [`--context=${context}`, '-n', ns, ...args],
      { encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    throw new Error(`kubectl --context=${context} -n ${ns} ${args.join(' ')} failed: ${e.stderr?.toString().trim() || e.message}`);
  }
}
function kubeGlobal(context, ...args) {
  try {
    return execFileSync('kubectl', [`--context=${context}`, ...args],
      { encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    // Cluster-scoped calls in this script are namespace create/delete only —
    // "already exists" / "not found" on those are expected on a re-run and safe
    // to ignore; anything else still surfaces loudly rather than vanishing.
    const msg = e.stderr?.toString().trim() || e.message;
    if (/already exists|not found/i.test(msg)) return '';
    throw new Error(`kubectl --context=${context} ${args.join(' ')} failed: ${msg}`);
  }
}
function kubeApply(context, ns, yamlStr) {
  try {
    return execSync(`kubectl --context=${context} -n ${ns} apply -f -`,
      { input: yamlStr, encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    throw new Error(`kubectl apply (--context=${context} -n ${ns}) failed: ${e.stderr?.toString().trim() || e.message}`);
  }
}
function waitRollout(context, ns, name, timeoutSec = 90) {
  try {
    execFileSync('kubectl', [`--context=${context}`, '-n', ns, 'rollout', 'status', `deployment/${name}`, `--timeout=${timeoutSec}s`],
      { encoding: 'utf8', timeout: (timeoutSec + 5) * 1000, stdio: 'pipe' });
  } catch { /* best-effort — only a courtesy pause before the second (broken) apply */ }
}
function kubeJson(context, ns, ...args) {
  const out = kube(context, ns, ...args, '-o', 'json');
  if (!out) return null;
  try { return JSON.parse(out); } catch { return null; }
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
function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

// =============================================================================
// TEST DEFINITIONS — 10 distinct broken pods, 5 per cluster, EVERY ONE with a
// real, defensible, evidence-backed kubectl fix. Both clusters here are a
// single node with ~12 CPU / ~7.6Gi allocatable (confirmed live, 2026-09-16) —
// resource values below are sized against that real capacity, not guessed:
// the "oversized" scenarios request far more than the node has (impossible to
// schedule), and the intended fix sizes down to something that comfortably
// fits alongside the other 4 tests running on the same node at once.
// =============================================================================
const NS_C3 = 'demo-fix-c3';
const NS_MK = 'demo-fix-mk';

function oomTest(cluster, ns, id) {
  return {
    id, cluster, ns, name: id,
    issue: 'OOMKilled (memory limit far below what the workload needs)',
    expectedFixable: true,
    fixCommand: `kubectl -n ${ns} set resources deployment/${id} -c oom --limits=memory=256Mi`,
    why: 'The limit (4Mi) is simply too low for a 128Mi workload — raising it is the actual intended remediation, not a guess.',
    create() {
      kubeApply(cluster, ns, `apiVersion: apps/v1
kind: Deployment
metadata: { name: ${id} }
spec:
  replicas: 1
  selector: { matchLabels: { app: ${id} } }
  template:
    metadata: { labels: { app: ${id} } }
    spec:
      containers:
      - name: oom
        image: polinux/stress
        command: ["stress","--vm","1","--vm-bytes","128M"]
        resources: { limits: { memory: "4Mi" } }`);
    },
  };
}

function badRolloutTest(cluster, ns, id) {
  return {
    id, cluster, ns, name: id,
    issue: 'Bad rollout (working v1 image -> broken v2, should rollback)',
    expectedFixable: true,
    fixCommand: `kubectl -n ${ns} rollout undo deployment/${id}`,
    why: 'A real prior-good revision (v1, nginx) exists in rollout history — rollback restores it exactly.',
    create() {
      kube(cluster, ns, 'create', 'deployment', id, '--image=nginx');
      waitRollout(cluster, ns, id);
      kubeApply(cluster, ns, `apiVersion: apps/v1
kind: Deployment
metadata: { name: ${id} }
spec:
  replicas: 1
  selector: { matchLabels: { app: ${id} } }
  template:
    metadata: { labels: { app: ${id} } }
    spec:
      containers:
      - name: ${id}
        image: busybox
        command: ["/bin/sh","-c","echo BAD && exit 1"]`);
    },
  };
}

function badNodeSelectorTest(cluster, ns, id) {
  return {
    id, cluster, ns, name: id,
    issue: 'Stuck Pending (nodeSelector references a label no node has)',
    expectedFixable: true,
    fixCommand: `kubectl -n ${ns} patch deployment ${id} --type=json -p '[{"op":"remove","path":"/spec/template/spec/nodeSelector"}]'`,
    why: 'The selector is simply a wrong/stale constraint — removing it is a real, defensible fix, not a guess about unknown intent. ' +
      '(Regression check for §Fix-SanitizerFalsePositive — this exact command shape was blocked by the policy sanitizer before 2026-09-16.)',
    create() {
      kubeApply(cluster, ns, `apiVersion: apps/v1
kind: Deployment
metadata: { name: ${id} }
spec:
  replicas: 1
  selector: { matchLabels: { app: ${id} } }
  template:
    metadata: { labels: { app: ${id} } }
    spec:
      nodeSelector:
        disktype: nonexistent-ssd-xyz
      containers:
      - name: app
        image: nginx`);
    },
  };
}

function oversizedRequestTest(cluster, ns, id) {
  return {
    id, cluster, ns, name: id,
    issue: 'Stuck Pending (impossible resource request: cpu=100, memory=999Gi on a ~12 CPU / ~7.6Gi node)',
    expectedFixable: true,
    fixCommand: `kubectl -n ${ns} set resources deployment/${id} -c big --requests=cpu=100m,memory=128Mi`,
    why: 'The request is oversized by orders of magnitude versus the real node capacity — right-sizing it to something the cluster can ' +
      'actually schedule is the real remediation. (Regression check for §Fix-CapacityEvidence — the Planner now has real node-allocatable ' +
      'evidence to size this from instead of guessing.)',
    create() {
      kubeApply(cluster, ns, `apiVersion: apps/v1
kind: Deployment
metadata: { name: ${id} }
spec:
  replicas: 1
  selector: { matchLabels: { app: ${id} } }
  template:
    metadata: { labels: { app: ${id} } }
    spec:
      containers:
      - name: big
        image: nginx
        resources:
          requests: { cpu: "100", memory: "999Gi" }`);
    },
  };
}

function overProvisionedReplicasTest(cluster, ns, id) {
  return {
    id, cluster, ns, name: id,
    issue: 'Over-provisioned replica count (25 x 500m cpu = 12500m, exceeds the ~12000m the node actually has)',
    expectedFixable: true,
    fixCommand: `kubectl -n ${ns} scale deployment/${id} --replicas=8`,
    why: 'The desired replica count simply exceeds real cluster capacity — scaling down to a count that fits is a real, defensible fix ' +
      '(any count that lets every replica become Ready counts, not one specific number). (Regression check for §Fix-CapacityEvidence.)',
    create() {
      kubeApply(cluster, ns, `apiVersion: apps/v1
kind: Deployment
metadata: { name: ${id} }
spec:
  replicas: 25
  selector: { matchLabels: { app: ${id} } }
  template:
    metadata: { labels: { app: ${id} } }
    spec:
      containers:
      - name: app
        image: nginx
        resources:
          requests: { cpu: "500m", memory: "128Mi" }`);
    },
  };
}

const TESTS = [
  // ── cluster3 ─────────────────────────────────────────────────────────────
  oomTest('cluster3', NS_C3, 'c3-oom'),
  badRolloutTest('cluster3', NS_C3, 'c3-badrollout'),
  badNodeSelectorTest('cluster3', NS_C3, 'c3-badnodeselector'),
  oversizedRequestTest('cluster3', NS_C3, 'c3-oversizedrequest'),
  overProvisionedReplicasTest('cluster3', NS_C3, 'c3-badreplicas'),
  // ── minikube ─────────────────────────────────────────────────────────────
  oomTest('minikube', NS_MK, 'mk-oom'),
  badRolloutTest('minikube', NS_MK, 'mk-badrollout'),
  badNodeSelectorTest('minikube', NS_MK, 'mk-badnodeselector'),
  oversizedRequestTest('minikube', NS_MK, 'mk-oversizedrequest'),
  overProvisionedReplicasTest('minikube', NS_MK, 'mk-badreplicas'),
];

// =============================================================================
// DECISION / PIPELINE EXTRACTION — reads the SAME structured, per-component
// decision events IncidentTracer.step() feeds at every graph.js node (see
// src/monitoring/liveWorkflowStore.js), i.e. exactly what the dashboard's Live
// Pipeline page renders. The full `pipeline` array is kept (not collapsed to
// "last write wins" per component) since an incident can carry several attempts
// and squashing hides which attempt actually fixed something.
// =============================================================================
async function fetchLiveWorkflows() {
  try {
    const d = await api('/api/live-workflows');
    return Array.isArray(d.items) ? d.items : [];
  } catch { return []; }
}
async function fetchShortMemoryState() {
  try { return await api('/api/live-workflows/short-memory'); } catch { return null; }
}

// Exact-pod match: clusterName AND namespace AND name(.includes) AND started
// at/after this run's start. All three identity fields must agree.
function matchIncident(items, test, afterMs) {
  const candidates = items.filter(it => {
    const r = it.resource ?? {};
    if ((r.clusterName ?? '') !== test.cluster) return false;
    if ((r.namespace ?? '') !== test.ns) return false;
    if (!r.name || !r.name.includes(test.name)) return false;
    const startedMs = new Date(it.startedAt).getTime();
    return Number.isFinite(startedMs) && startedMs >= afterMs;
  });
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  return candidates[0];
}

function lastByComponent(steps, component) {
  const matches = steps.filter(s => s.component === component);
  return matches.length ? matches[matches.length - 1].output : null;
}

function decisionFromIncident(incident) {
  const steps = incident.steps ?? [];
  const investigator = lastByComponent(steps, 'investigator');
  const planner       = lastByComponent(steps, 'planner');
  const executor       = lastByComponent(steps, 'executor');
  const reflector       = lastByComponent(steps, 'reflector');

  return {
    status: incident.outcome ?? (incident.finishedAt ? 'finished' : 'in_progress'),
    pipelineReady:   executor && 'ready' in executor ? !!executor.ready : null,
    planSummary:     planner?.plan_summary ?? null,
    rootCauseLayer:  investigator?.root_cause_layer ?? null,
    escalated:       incident.outcome === 'escalated' || reflector?.outcome === 'escalated',
    reflectorOutcome: reflector?.outcome ?? null,
    attemptCount:    steps.filter(s => s.component === 'investigator').length,
    pipeline: steps,
    incident,
  };
}

// =============================================================================
// REAL-FIX CHECK — independent live kubectl re-verification, not "the agent said
// it acted". Reads the Deployment's own status (readyReplicas/updatedReplicas
// vs spec.replicas) rather than scanning pods by label, so a partially-scaled
// fix is never miscounted as fully fixed. Rechecked once more ~STABILITY_GAP_MS
// later to rule out flapping.
// =============================================================================
function readDeploymentHealth(test) {
  const dep = kubeJson(test.cluster, test.ns, 'get', 'deployment', test.name);
  if (!dep) return { healthy: false, detail: 'deployment not found' };
  const desired = dep.spec?.replicas ?? 0;
  const ready   = dep.status?.readyReplicas ?? 0;
  const updated = dep.status?.updatedReplicas ?? 0;
  const healthy = desired > 0 && ready === desired && updated === desired;
  return { healthy, detail: `ready=${ready}/${desired} updated=${updated}/${desired}` };
}

async function checkReallyFixed(test) {
  const deadline = Date.now() + FIX_CHECK_TIMEOUT_MS;
  let last = readDeploymentHealth(test);
  while (!last.healthy && Date.now() < deadline) {
    await sleep(FIX_CHECK_POLL_MS);
    last = readDeploymentHealth(test);
  }
  if (!last.healthy) {
    return { fixed: false, detail: `${last.detail} (gave up after ${(FIX_CHECK_TIMEOUT_MS / 1000).toFixed(0)}s of polling)` };
  }
  await sleep(STABILITY_GAP_MS);
  const second = readDeploymentHealth(test);
  if (!second.healthy) return { fixed: false, detail: `healthy briefly, then: ${second.detail}` };
  return { fixed: true, detail: second.detail };
}

// =============================================================================
// MAIN
// =============================================================================
async function main() {
  console.log(`\n${C.B}${C.b}━━━ Dual-Cluster Must-Fix Demo ━━━${C.n}`);
  console.log(`${C.d}10 distinct broken pods — 5 on cluster3, 5 on minikube — ALL expected fixable — api=${API}${C.n}\n`);

  await login();
  console.log(`${C.g}  OK${C.n} Logged in\n`);

  kubeGlobal('cluster3', 'create', 'namespace', NS_C3);
  kubeGlobal('minikube', 'create', 'namespace', NS_MK);

  const benchStartMs = Date.now();
  const startTimes = {};
  // §Fix-SilentSetupFailure — tests whose create() threw are excluded from the
  // detection/fix-check loop entirely and reported as their own outcome, never
  // silently conflated with "the pipeline already fixed it".
  const setupFailed = {};

  console.log(`${C.b}[create]${C.n} Deploying ${TESTS.length} broken workloads...`);
  for (const t of TESTS) {
    process.stdout.write(`  ${C.b}*${C.n} [${t.cluster}] ${t.name} — ${t.issue}...`);
    startTimes[t.id] = Date.now();
    try {
      t.create();
      // Confirm the resource actually landed before trusting this test is live —
      // an apply that silently no-ops (e.g. a transient API error swallowed
      // somewhere upstream of this script) must not be mistaken for a real,
      // freshly-broken pod.
      const dep = kubeJson(t.cluster, t.ns, 'get', 'deployment', t.name);
      if (!dep) throw new Error('deployment not found immediately after create()');
      console.log(` ${C.g}created${C.n}`);
    } catch (e) {
      console.log(` ${C.r}SETUP FAILED: ${e.message}${C.n}`);
      setupFailed[t.id] = e.message;
    }
  }

  const liveTests = TESTS.filter(t => !setupFailed[t.id]);
  if (liveTests.length < TESTS.length) {
    console.log(`\n  ${C.y}${C.B}${TESTS.length - liveTests.length} test(s) failed to set up${C.n} — excluded from detection/fix-check below, reported separately.`);
  }

  // ── Poll for detection (idle-confirmed, same signal as agent-benchmark-advanced1.js) ──
  console.log(`\n${C.b}[poll]${C.n} Waiting for detection of all ${liveTests.length} pods (idle-detection, ${TIMEOUT}s hard cap)...\n`);

  const decisions = {};
  const detectionTimes = {};
  let elapsed = 0;
  let idleTicks = 0;
  let stopReason = 'safety-cap';

  while (elapsed < TIMEOUT) {
    await sleep(POLL * 1000);
    elapsed += POLL;

    const liveItems = await fetchLiveWorkflows();
    for (const t of liveTests) {
      if (decisions[t.id]) continue;
      const incident = matchIncident(liveItems, t, benchStartMs);
      if (incident) {
        decisions[t.id] = decisionFromIncident(incident);
        detectionTimes[t.id] = Date.now() - startTimes[t.id];
      }
    }

    const detectedCount = liveTests.filter(t => decisions[t.id]).length;
    const sm = await fetchShortMemoryState();
    const queueDepth = sm?.queue?.length ?? '?';
    const activeCount = sm?.activeWorkflows?.length ?? '?';
    process.stdout.write(`\r  ${elapsed}s — detected: ${detectedCount}/${liveTests.length}   queue=${queueDepth} active=${activeCount}   `);

    if (detectedCount >= liveTests.length) { stopReason = 'all-detected'; break; }

    if (sm && sm.ready === false) {
      console.log(`\n\n  ${C.r}${C.B}Short Memory (Redis) is unreachable${C.n} — dispatch is fleet-wide disabled, nothing further will be detected this run.`);
      stopReason = 'shortmemory-offline';
      break;
    }

    const isIdle = sm?.ready && (sm.queue?.length ?? 0) === 0 && (sm.activeWorkflows?.length ?? 0) === 0 && (sm.groups?.length ?? 0) === 0;
    idleTicks = isIdle ? idleTicks + 1 : 0;
    if (idleTicks >= IDLE_CONFIRM_TICKS) {
      console.log(`\n\n  ${C.y}System idle for ${IDLE_CONFIRM_TICKS * POLL}s${C.n} with ${liveTests.length - detectedCount} pod(s) still undetected — concluding these are real misses.`);
      stopReason = 'idle-confirmed';
      break;
    }
  }
  if (stopReason === 'safety-cap') {
    console.log(`\n\n  ${C.r}${C.B}Hit the ${TIMEOUT}s safety cap${C.n} while the system was STILL actively working — remaining undetected pods are genuinely unknown, not confirmed misses.`);
  }

  // Final authoritative fetch — catches anything that landed in the gap since the last tick.
  const finalItems = await fetchLiveWorkflows();
  for (const t of liveTests) {
    if (decisions[t.id]) continue;
    const incident = matchIncident(finalItems, t, benchStartMs);
    if (incident) { decisions[t.id] = decisionFromIncident(incident); detectionTimes[t.id] = Date.now() - startTimes[t.id]; }
  }
  console.log('\n');

  // ── Real-fix check — live kubectl re-verification per detected pod ──
  console.log(`${C.B}${C.b}━━━ Verifying real fixes (live kubectl, ${STABILITY_GAP_MS / 1000}s stability window) ━━━${C.n}\n`);

  const results = [];
  for (const t of TESTS) {
    if (setupFailed[t.id]) {
      console.log(`  ${C.b}*${C.n} [${t.cluster}] ${t.name}... ${C.r}SETUP FAILED${C.n} ${C.d}${setupFailed[t.id]}${C.n}`);
      results.push({
        id: t.id, cluster: t.cluster, ns: t.ns, name: t.name, issue: t.issue, why: t.why,
        expectedFixable: t.expectedFixable, fixCommand: t.fixCommand,
        detected: false, unknown: false, setupFailed: true, setupError: setupFailed[t.id],
        latencyMs: null, liveFixed: false, liveDetail: 'fixture setup failed — not a real test of the agent this run',
        pipelineReady: null, agree: null, matchesExpectation: false,
        planSummary: null, rootCauseLayer: null, escalated: false, attemptCount: 0, pipeline: [],
      });
      continue;
    }

    const dec = decisions[t.id] ?? null;
    process.stdout.write(`  ${C.b}*${C.n} [${t.cluster}] ${t.name}...`);
    let fixResult = { fixed: false, detail: 'not detected — no remediation to verify' };
    if (dec) {
      process.stdout.write(' checking...');
      fixResult = await checkReallyFixed(t);
    }
    const unknown = !dec && (stopReason === 'safety-cap' || stopReason === 'shortmemory-offline');
    const matchesExpectation = !!dec && fixResult.fixed === t.expectedFixable;
    const agree = dec && dec.pipelineReady !== null ? dec.pipelineReady === fixResult.fixed : null;

    console.log(
      dec
        ? ` detected → live=${fixResult.fixed ? C.g + 'FIXED' : C.r + 'NOT FIXED'}${C.n} pipeline=${dec.pipelineReady === null ? C.d + 'n/a' : dec.pipelineReady ? C.g + 'ready' : C.r + 'not ready'}${C.n}${agree === false ? ` ${C.y}[DISAGREE]${C.n}` : ''} ${C.d}${fixResult.detail}${C.n}`
        : unknown ? ` ${C.y}UNKNOWN (run stopped before confirming)${C.n}` : ` ${C.r}NOT DETECTED${C.n}`
    );

    results.push({
      id: t.id, cluster: t.cluster, ns: t.ns, name: t.name, issue: t.issue, why: t.why,
      expectedFixable: t.expectedFixable, fixCommand: t.fixCommand,
      detected: !!dec, unknown, setupFailed: false, setupError: null,
      latencyMs: detectionTimes[t.id] ?? null,
      liveFixed: !!dec && fixResult.fixed, liveDetail: fixResult.detail,
      pipelineReady: dec?.pipelineReady ?? null,
      agree,
      matchesExpectation,
      planSummary: dec?.planSummary ?? null,
      rootCauseLayer: dec?.rootCauseLayer ?? null,
      escalated: dec?.escalated ?? false,
      attemptCount: dec?.attemptCount ?? 0,
      pipeline: dec?.pipeline ?? [],
    });
  }

  // ── Metrics ── (no fixable/unfixable split here — every test is expectedFixable)
  const scoredResults = results.filter(r => !r.setupFailed);
  const detectedCount = scoredResults.filter(r => r.detected).length;
  const fixedCount = scoredResults.filter(r => r.liveFixed).length;
  const detectionRate = scoredResults.length ? detectedCount / scoredResults.length : null;
  const fixRate = scoredResults.length ? fixedCount / scoredResults.length : null;
  const latencies = scoredResults.filter(r => r.latencyMs != null).map(r => r.latencyMs);
  const avgLatency = latencies.length ? (latencies.reduce((a, b) => a + b, 0) / latencies.length / 1000).toFixed(1) : 'n/a';
  const disagreements = scoredResults.filter(r => r.agree === false);
  const setupFailedCount = results.filter(r => r.setupFailed).length;

  console.log(`\n${C.B}${C.b}━━━ Results ━━━${C.n}\n`);
  console.log(`  Stop reason:                  ${stopReason === 'idle-confirmed' || stopReason === 'all-detected' ? C.g : C.y}${stopReason}${C.n}`);
  if (setupFailedCount > 0) console.log(`  ${C.r}${C.B}Setup failed:                 ${setupFailedCount}/${TESTS.length}${C.n} (excluded from the rates below)`);
  console.log(`  ${C.B}Detected:                     ${detectedCount}/${scoredResults.length} (${detectionRate != null ? (detectionRate * 100).toFixed(0) : '?'}%)${C.n}`);
  console.log(`  ${C.B}Fixed:                        ${fixedCount}/${scoredResults.length} (${fixRate != null ? (fixRate * 100).toFixed(0) : '?'}%)${C.n}`);
  console.log(`  Avg detection latency:        ${avgLatency}s`);
  if (disagreements.length) {
    console.log(`\n  ${C.y}${C.B}${disagreements.length} pod(s) where the pipeline's own verdict disagreed with the live re-check${C.n} — see the "pipeline" trail in the JSON/HTML report for why:`);
    for (const r of disagreements) console.log(`    ${C.y}*${C.n} ${r.name}: pipeline said ready=${r.pipelineReady}, live check said fixed=${r.liveFixed}`);
  }

  console.log(`\n  ${C.B}Per pod:${C.n}`);
  for (const r of results) {
    const badge = r.setupFailed ? `${C.r}SETUP FAILED`
      : r.unknown ? `${C.y}UNKNOWN`
      : !r.detected ? `${C.r}MISSED`
      : r.liveFixed ? `${C.g}FIXED`
      : `${C.r}NOT FIXED`;
    console.log(`    ${badge}${C.n}  [${r.cluster}] ${r.name.padEnd(24)} ${C.d}${r.issue}${C.n}`);
    if (r.detected) console.log(`             pipeline_ready=${r.pipelineReady}  attempts=${r.attemptCount}  ${C.d}${r.liveDetail}${C.n}`);
  }

  // ── Save JSON + HTML ──
  if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
  let commit = 'unknown';
  try { commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim(); } catch {}

  const report = {
    date: new Date().toISOString(), commit, benchmark: 'dual-cluster-must-fix-demo',
    clusters: ['cluster3', 'minikube'], stopReason,
    metrics: {
      total: TESTS.length, setupFailedCount, scored: scoredResults.length,
      detectionRate, detectedCount, fixRate, fixedCount,
      avgLatencyMs: latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null,
      disagreementCount: disagreements.length,
    },
    tests: results,
  };

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const jsonName = `dual-cluster-must-fix-${stamp}.json`;
  fs.writeFileSync(path.join(RESULTS_DIR, jsonName), JSON.stringify(report, null, 2));
  console.log(`\n${C.d}Report: benchmark/results/${jsonName}${C.n}`);

  const htmlName = jsonName.replace('.json', '.html');
  fs.writeFileSync(path.join(RESULTS_DIR, htmlName), buildHtmlReport(report));
  console.log(`${C.d}HTML:   benchmark/results/${htmlName}${C.n}`);

  console.log(`\n${C.b}[cleanup]${C.n} Removing test namespaces (${NS_C3}, ${NS_MK})...`);
  kubeGlobal('cluster3', 'delete', 'namespace', NS_C3, '--ignore-not-found', '--wait=false');
  kubeGlobal('minikube', 'delete', 'namespace', NS_MK, '--ignore-not-found', '--wait=false');

  console.log(`\n${C.d}Done. Press Ctrl+C to exit.${C.n}\n`);
  if (process.platform === 'win32') await new Promise(() => {});
}

// =============================================================================
// HTML REPORT — same dark palette / <details> pipeline-trail pattern as the
// other benchmark reports in this repo.
// =============================================================================
const WORKFLOW_STEP = {
  investigator: { icon: '🔎', label: 'Investigator' },
  planner:      { icon: '🧩', label: 'Planner' },
  guardian:     { icon: '🛡',  label: 'Guardian' },
  policy:       { icon: '📋', label: 'Policy' },
  executor:     { icon: '⚙',  label: 'Executor' },
  reflector:    { icon: '🪞', label: 'Reflexion' },
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function badge(pass, label) {
  return `<span class="badge ${pass ? 'badge-success' : 'badge-danger'}">${esc(label)}</span>`;
}
function stepFieldsHtml(output) {
  const entries = Object.entries(output ?? {}).filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (entries.length === 0) return '<div class="no-decision">(no additional output)</div>';
  return `<div class="step-fields">${entries.map(([k, v]) =>
    `<div class="step-field"><span class="step-field-key">${esc(k)}</span><span class="step-field-val">${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</span></div>`
  ).join('')}</div>`;
}
function pipelineHtml(pipeline) {
  if (!pipeline?.length) return '<div class="no-decision">No live-pipeline steps recorded for this pod.</div>';
  return `<div class="steps">${pipeline.map(s => {
    const meta = WORKFLOW_STEP[s.component] ?? { icon: '•', label: s.component };
    const dur = s.durationMs != null ? ` <span class="step-time">(${s.durationMs}ms)</span>` : '';
    return `<div class="step">
      <div class="step-head">${meta.icon} ${esc(meta.label)} <span class="step-time">${esc(s.ts)}</span>${dur}</div>
      ${stepFieldsHtml(s.output)}
    </div>`;
  }).join('')}</div>`;
}

function buildHtmlReport(report) {
  const m = report.metrics;
  const metric = (val, lbl) => `<div class="metric"><div class="val">${esc(val)}</div><div class="lbl">${esc(lbl)}</div></div>`;

  const rows = report.tests.map(r => {
    const overall = r.setupFailed ? '<span class="badge badge-warn">SETUP FAILED</span>'
      : r.unknown ? '<span class="badge badge-warn">UNKNOWN</span>'
      : !r.detected ? badge(false, 'MISSED')
      : badge(r.liveFixed, r.liveFixed ? 'FIXED' : 'NOT FIXED');
    const latency = r.latencyMs != null ? `${(r.latencyMs / 1000).toFixed(1)}s` : '—';
    const agreeNote = r.agree === false ? '<div class="mono" style="color:var(--warn)">pipeline/live-check disagree</div>' : '';
    return `<tr>
      <td>${overall}</td>
      <td>${esc(r.cluster)}</td>
      <td><div>${esc(r.name)}</div><div class="mono">ns/${esc(r.ns)}</div></td>
      <td>${esc(r.issue)}<div class="mono">${esc(r.why)}</div><div class="mono">fix: ${esc(r.fixCommand)}</div></td>
      <td>${r.setupFailed ? `<span class="mono" style="color:var(--danger)">${esc(r.setupError)}</span>` : (r.detected ? badge(true, 'detected') : badge(false, 'not detected'))}</td>
      <td>${r.detected ? badge(r.liveFixed, r.liveFixed ? 'FIXED' : 'NOT FIXED') : '—'}<div class="mono">${esc(r.liveDetail ?? '')}</div></td>
      <td>${r.pipelineReady === null ? '<span class="badge badge-dim">n/a</span>' : badge(r.pipelineReady, r.pipelineReady ? 'ready' : 'not ready')}${agreeNote}</td>
      <td class="mono">${latency}</td>
      <td><details><summary>Pipeline (${r.attemptCount} attempt${r.attemptCount === 1 ? '' : 's'}) ▸</summary>${pipelineHtml(r.pipeline)}</details></td>
    </tr>`;
  }).join('');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Dual-Cluster Must-Fix Demo</title>
<style>
  :root { --bg:#0d0f14; --surface:#13161f; --surface-2:#1c1f2e; --border:#2a2d3e; --text:#c8cdd8; --text-dim:#6b7280; --text-head:#f0f2f8; --primary:#6366f1; --success:#22c55e; --warn:#f59e0b; --danger:#ef4444; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:13px/1.5 -apple-system,Segoe UI,sans-serif; padding:28px; }
  h1 { color:var(--text-head); font-size:20px; margin:0 0 4px; }
  .subtitle { color:var(--text-dim); margin:0 0 24px; font-size:12.5px; }
  .metrics { display:flex; flex-wrap:wrap; gap:12px; margin-bottom:28px; }
  .metric { background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:14px 20px; min-width:150px; }
  .metric .val { font-size:24px; font-weight:700; color:var(--text-head); }
  .metric .lbl { font-size:11px; color:var(--text-dim); text-transform:uppercase; letter-spacing:.03em; }
  table { width:100%; border-collapse:collapse; background:var(--surface); border:1px solid var(--border); border-radius:10px; overflow:hidden; }
  th, td { padding:9px 12px; text-align:left; border-bottom:1px solid var(--border); font-size:12.5px; vertical-align:top; }
  th { color:var(--text-dim); text-transform:uppercase; font-size:10.5px; letter-spacing:.04em; background:var(--surface-2); }
  tr:last-child td { border-bottom:none; }
  .badge { display:inline-block; padding:2px 9px; border-radius:99px; font-size:11px; font-weight:600; white-space:nowrap; margin-top:4px; }
  .badge-success { background:rgba(34,197,94,.15); color:var(--success); }
  .badge-danger  { background:rgba(239,68,68,.15); color:var(--danger); }
  .badge-warn    { background:rgba(245,158,11,.15); color:var(--warn); }
  .badge-dim     { background:rgba(107,114,128,.15); color:var(--text-dim); }
  .mono { font-family:ui-monospace,Consolas,monospace; font-size:11px; color:var(--text-dim); word-break:break-word; margin-top:3px; }
  details > summary { cursor:pointer; color:var(--primary); font-size:11.5px; }
  .steps { margin-top:8px; display:flex; flex-direction:column; gap:6px; max-width:420px; }
  .step { border:1px solid var(--border); border-radius:8px; padding:8px 10px; background:var(--surface-2); }
  .step-head { font-weight:600; color:var(--text-head); font-size:12px; }
  .step-time { color:var(--text-dim); font-weight:400; font-size:10.5px; }
  .step-fields { margin-top:6px; display:flex; flex-direction:column; gap:2px; }
  .step-field { display:flex; gap:6px; font-size:11.5px; }
  .step-field-key { color:var(--text-dim); min-width:110px; flex-shrink:0; }
  .step-field-val { color:var(--text); word-break:break-word; }
  .no-decision { color:var(--text-dim); font-style:italic; font-size:12px; margin-top:6px; }
</style>
</head>
<body>
  <h1>Dual-Cluster Must-Fix Demo</h1>
  <p class="subtitle">clusters: cluster3 + minikube &middot; ${esc(report.date)} (UTC) &middot; commit ${esc(report.commit)} &middot; stop reason: <b>${esc(report.stopReason)}</b>${m.disagreementCount > 0 ? ` &mdash; <span style="color:var(--warn)">${m.disagreementCount} pipeline/live-check disagreement(s), see below</span>` : ''}${m.setupFailedCount > 0 ? ` &mdash; <span style="color:var(--danger)">${m.setupFailedCount} test(s) failed to set up, excluded from rates</span>` : ''}</p>
  <div class="metrics">
    ${metric(`${m.detectedCount}/${m.scored}`, 'Detected')}
    ${metric(m.detectionRate != null ? `${(m.detectionRate * 100).toFixed(0)}%` : 'n/a', 'Detection rate')}
    ${metric(`${m.fixedCount}/${m.scored}`, 'Fixed')}
    ${metric(m.fixRate != null ? `${(m.fixRate * 100).toFixed(0)}%` : 'n/a', 'Fix rate')}
    ${metric(m.avgLatencyMs != null ? `${(m.avgLatencyMs / 1000).toFixed(1)}s` : 'n/a', 'Avg detection latency')}
  </div>
  <table>
    <thead><tr><th></th><th>Cluster</th><th>Pod</th><th>Issue / real fix</th><th>Detection</th><th>Live re-check</th><th>Pipeline verdict</th><th>Latency</th><th>Investigation &amp; pipeline</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`;
}

main().catch(err => {
  console.error(`\n${C.r}Fatal: ${err.message}${C.n}`);
  if (process.platform === 'win32') { process.stdin.resume(); process.stdin.on('data', () => process.exit(1)); }
  else process.exit(1);
});
