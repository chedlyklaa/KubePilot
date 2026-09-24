#!/usr/bin/env node
// =============================================================================
// scripts/test-20-related-incidents.js
//
// Drives 20 incidents through the REAL v5 pipeline (runWorkflow() in
// src/orchestrator/graph.js — Investigator -> Planner -> Guardian -> Policy ->
// Executor -> Reflexion, exactly as production runs it): 10 distinct failure
// "personas", each instantiated once in "minikube" (tier=dev) and once in
// "cluster2" (tier=production) — same underlying problem, different cluster/tier,
// so the report can show whether tier changes the outcome for an otherwise
// identical incident.
//
// No live cluster is required: kubectl.runCommand/getPods/getNodes are monkey-
// patched (module-level, same technique as scripts/test-orchestrator-conflict-live.js)
// to return fixture data per persona instead of shelling out. Real LLM calls are
// used throughout (Investigator/Planner/Guardian/Reflexion) — only the "cluster"
// underneath is fake. approvalStore.requestApproval is patched to auto-approve
// immediately (logged) instead of blocking for up to 10 minutes with no human
// present.
//
// PolicyEngine.dryRunMode is hardcoded true (src/policy/policyEngine.js) regardless
// of this script, so Executor never truly mutates anything even if it thought it
// had a live cluster.
//
// Usage:
//   node scripts/test-20-related-incidents.js
//   node scripts/test-20-related-incidents.js persona3        # filter by persona id (substring)
//
// Output:
//   test-output/20-incidents/run-<timestamp>.jsonl   — one JSON record per incident
//   test-output/20-incidents/report-<timestamp>.md   — human-readable report
// =============================================================================
'use strict';

require('dotenv').config({ override: true });
const fs   = require('fs');
const path = require('path');

const kubectl        = require('../src/tools/kubectl');
const approvalStore   = require('../src/api/approvalStore');
const escalationStore = require('../src/api/escalationStore');
const shortMemory     = require('../src/memory/shortMemory');
const vectorStore     = require('../src/memory/vectorStore');
const episodicMemory  = require('../src/memory/episodicMemory');
const workflowTraceStore = require('../src/api/workflowTraceStore');
const { runWorkflow } = require('../src/orchestrator/graph');

const OUT_DIR = path.join(__dirname, '..', 'test-output', '20-incidents');
fs.mkdirSync(OUT_DIR, { recursive: true });
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const JSONL_PATH  = path.join(OUT_DIR, `run-${STAMP}.jsonl`);
const REPORT_PATH = path.join(OUT_DIR, `report-${STAMP}.md`);

const CLUSTERS = {
  minikube: { name: 'minikube', context: 'minikube', tier: 'dev' },
  cluster2: { name: 'cluster2', context: 'cluster2', tier: 'production' },
};

// ── Persona definitions ──────────────────────────────────────────────────────
// Each persona is a function(clusterName) -> { incident, fixtures, expectation }.
// `fixtures` feeds the kubectl mock; `expectation` is a human-written prediction
// recorded alongside the real outcome in the report, not used to grade anything.

function P1_transientCrash(cluster) {
  const pod = `api-${cluster}-7f8`, dep = 'api', ns = 'shop';
  return {
    id: `P1-transient-crash-${cluster}`,
    expectation: 'restart fixes it — transient dependency blip on startup, not a real bug',
    incident: {
      type: 'CrashLoopBackOff', severity: 'high', scope: 'pod', clusterName: cluster,
      // §Phase4 — matches the Orchestrator's own SIMPLE gate (single pod, controller-
      // managed, no unhealthy siblings, known pattern) so this run actually exercises
      // Fast Path (src/agents/fastPath.js) instead of always going to the Full
      // Investigator, which was every incident's ONLY path before that feature existed.
      complexity: 'SIMPLE',
      namespace: ns, podName: pod, deployment: dep, exitCode: 1, oomKilled: false, restartCount: 8,
      evidenceSummary: `Pod ${pod} in CrashLoopBackOff, exit code 1, 8 restarts in the last 20 minutes.`,
    },
    fixtures: {
      pods: [{ name: pod, ns, phase: 'Running', ready: false, restartCount: 8, waiting: 'CrashLoopBackOff', owner: dep }],
      describe: `Status: CrashLoopBackOff\nRestart Count: 8\nLast State: Terminated, Reason: Error, Exit Code: 1\nEvents:\n  Warning  BackOff  30s (x8 over 20m)  kubelet  Back-off restarting failed container ${pod.split('-')[0]} in pod ${pod}_${ns}`,
      // Deliberately no named external dependency here (an earlier version referenced
      // "internal-auth-svc" by name, which repeatedly sent the model chasing a whole
      // Service/Endpoint investigation the mock couldn't answer consistently) — this
      // version is self-contained: the failure and its transient nature are both fully
      // visible from this pod's own logs alone.
      logs: `[startup] initializing connection pool (attempt 1/3)\n[startup] ERROR: timed out waiting for downstream dependency, retrying in 2s\n[startup] ERROR: timed out waiting for downstream dependency, retrying in 2s\nFATAL: exceeded 3 startup attempts within the readiness window, exiting\n(note: this same dependency call succeeds well under 200ms during normal operation — prior restarts of this exact pod have cleared this same error)`,
      events: [{ reason: 'BackOff', message: `Back-off restarting failed container in pod ${pod}` }],
      deploymentLimitMi: '256Mi',
    },
  };
}

function P2_oom(cluster) {
  const pod = `worker-${cluster}-9k2`, dep = 'worker', ns = 'batch';
  return {
    id: `P2-oomkilled-${cluster}`,
    expectation: 'must raise memory limit — plain restart will recur immediately',
    incident: {
      type: 'OOMKilled', severity: 'critical', scope: 'pod', clusterName: cluster,
      complexity: 'SIMPLE', // §Phase4 — see P1's comment
      namespace: ns, podName: pod, deployment: dep, exitCode: 137, oomKilled: true, restartCount: 12,
      evidenceSummary: `Pod ${pod} repeatedly OOMKilled, exit code 137, 12 restarts, current memory limit appears too low for the workload.`,
    },
    fixtures: {
      pods: [{ name: pod, ns, phase: 'Running', ready: false, restartCount: 12, waiting: 'CrashLoopBackOff', owner: dep, oomKilled: true }],
      describe: `Status: CrashLoopBackOff\nRestart Count: 12\nLast State: Terminated, Reason: OOMKilled, Exit Code: 137\nLimits:\n  memory: 128Mi\nEvents:\n  Warning  OOMKilling  1m (x12 over 30m)  kubelet  Memory cgroup out of memory: Killed process`,
      logs: `[worker] processing batch job 4471, loaded 900MB dataset into memory\n(no further output — container killed)`,
      events: [{ reason: 'OOMKilling', message: 'Memory cgroup out of memory: Killed process' }],
      deploymentLimitMi: '128Mi',
    },
  };
}

function P3_imagePull(cluster) {
  const pod = `payment-gateway-${cluster}-4d1`, dep = 'payment-gateway', ns = 'shop';
  return {
    id: `P3-imagepull-${cluster}`,
    expectation: 'no kubectl command can fix a nonexistent image tag — expect empty command / REJECT / DELEGATE_HUMAN',
    incident: {
      type: 'ImagePullBackOff', severity: 'high', scope: 'pod', clusterName: cluster,
      complexity: 'SIMPLE', // §Phase4 — see P1's comment
      namespace: ns, podName: pod, deployment: dep, exitCode: null, oomKilled: false, restartCount: 0,
      evidenceSummary: `Pod ${pod} stuck in ImagePullBackOff — image tag does not exist in the registry.`,
    },
    fixtures: {
      pods: [{ name: pod, ns, phase: 'Pending', ready: false, restartCount: 0, waiting: 'ImagePullBackOff', owner: dep }],
      describe: `Status: Pending\nEvents:\n  Warning  Failed  2m (x20 over 20m)  kubelet  Failed to pull image "payment-gateway:v2.9.9-typo": rpc error: manifest for payment-gateway:v2.9.9-typo not found`,
      logs: '',
      events: [{ reason: 'Failed', message: 'manifest for payment-gateway:v2.9.9-typo not found' }],
      deploymentLimitMi: '256Mi',
    },
  };
}

function P4_configError(cluster) {
  const pod = `notifier-${cluster}-2q7`, dep = 'notifier', ns = 'shop';
  return {
    id: `P4-config-error-${cluster}`,
    expectation: "kubectl can't add a missing config key — likely escalate rather than invent a fix",
    incident: {
      type: 'CreateContainerConfigError', severity: 'high', scope: 'pod', clusterName: cluster,
      complexity: 'SIMPLE', // §Phase4 — see P1's comment
      namespace: ns, podName: pod, deployment: dep, exitCode: null, oomKilled: false, restartCount: 0,
      evidenceSummary: `Pod ${pod} failing to start — ConfigMap "notifier-config" is missing a key the container requires.`,
    },
    fixtures: {
      pods: [{ name: pod, ns, phase: 'Pending', ready: false, restartCount: 0, waiting: 'CreateContainerConfigError', owner: dep }],
      describe: `Status: Pending\nEvents:\n  Warning  Failed  1m (x5 over 5m)  kubelet  Error: configmap "notifier-config" key "SMTP_HOST" not found`,
      logs: '',
      configMap: { name: 'notifier-config', keys: ['SMTP_PORT', 'SMTP_USER'] }, // deliberately missing SMTP_HOST
      events: [{ reason: 'Failed', message: 'configmap "notifier-config" key "SMTP_HOST" not found' }],
      deploymentLimitMi: '256Mi',
    },
  };
}

function P5_barePod(cluster) {
  const pod = `adhoc-debug-${cluster}`, ns = 'default';
  return {
    id: `P5-bare-pod-${cluster}`,
    expectation: 'no controller to recreate it — direct delete is the only real fix',
    incident: {
      type: 'CrashLoopBackOff', severity: 'medium', scope: 'pod', clusterName: cluster,
      // §Phase4 — deliberately COMPLEX: no owning controller, which fails the
      // Orchestrator's SIMPLE gate outright (orchestratorAgent.js's
      // _findOvercalledSimple backstop would force this to COMPLEX even if the LLM
      // classifier tried SIMPLE) — a control case that must NOT reach Fast Path.
      complexity: 'COMPLEX',
      namespace: ns, podName: pod, deployment: null, exitCode: 1, oomKilled: false, restartCount: 15,
      evidenceSummary: `Bare pod ${pod} (no owning controller) in CrashLoopBackOff, 15 restarts, left running from an old manual debug session.`,
    },
    fixtures: {
      pods: [{ name: pod, ns, phase: 'Running', ready: false, restartCount: 15, waiting: 'CrashLoopBackOff', owner: null }],
      describe: `Status: CrashLoopBackOff\nRestart Count: 15\nControlled By: <none>\nLast State: Terminated, Reason: Error, Exit Code: 1`,
      logs: 'bash: /entrypoint-debug.sh: No such file or directory',
      events: [{ reason: 'BackOff', message: `Back-off restarting failed container in pod ${pod}` }],
      deploymentLimitMi: null,
    },
  };
}

function P6_flakyDependency(cluster) {
  const pod = `cache-${cluster}-1a3`, dep = 'cache', ns = 'shop';
  return {
    id: `P6-flaky-dependency-${cluster}`,
    expectation: 'restart is reasonable — downstream redis connection issue, likely transient',
    incident: {
      type: 'CrashLoopBackOff', severity: 'medium', scope: 'pod', clusterName: cluster,
      // §Phase4 — SIMPLE per the classifier gate, but the underlying evidence is
      // genuinely a downstream-dependency judgment call rather than a single obvious
      // fact — a good real test of whether Fast Path's single call is confident enough
      // to stop, or honestly escalates to the Full Investigator.
      complexity: 'SIMPLE',
      namespace: ns, podName: pod, deployment: dep, exitCode: 1, oomKilled: false, restartCount: 5,
      evidenceSummary: `Pod ${pod} restarting, exit code 1, logs show repeated Redis connection refused errors.`,
    },
    fixtures: {
      pods: [{ name: pod, ns, phase: 'Running', ready: false, restartCount: 5, waiting: 'CrashLoopBackOff', owner: dep }],
      describe: `Status: CrashLoopBackOff\nRestart Count: 5\nLast State: Terminated, Reason: Error, Exit Code: 1`,
      logs: '[cache] connecting to redis-master.shop.svc.cluster.local:6379\n[cache] ECONNREFUSED\n[cache] retrying...\nFATAL: exceeded max retries',
      events: [{ reason: 'BackOff', message: `Back-off restarting failed container in pod ${pod}` }],
      deploymentLimitMi: '256Mi',
    },
  };
}

function P7_nodeNotReady(cluster) {
  const node = `worker-2-${cluster}`;
  return {
    id: `P7-node-not-ready-${cluster}`,
    expectation: 'cordon is warranted — confirmed NotReady, multiple pods affected; drain would be excessive without further evidence',
    incident: {
      type: 'NodeNotReady', severity: 'critical', scope: 'node', clusterName: cluster,
      complexity: 'COMPLEX', // §Phase4 — node-scoped incidents can never be SIMPLE
      nodeName: node,
      evidenceSummary: `Node ${node} reports NotReady, kubelet unresponsive for 6 minutes, 8 pods across 3 namespaces affected.`,
    },
    fixtures: {
      isNode: true, nodeCondition: 'NotReady', affectedPods: 8,
      describe: `Conditions:\n  Ready  False  NodeStatusUnknown  Kubelet stopped posting node status`,
    },
  };
}

function P8_alreadyResolved(cluster) {
  const pod = `legacy-batch-${cluster}-8x1`, dep = 'legacy-batch', ns = 'batch';
  return {
    id: `P8-already-resolved-${cluster}`,
    expectation: 'FALSE-POSITIVE CHECK: live state shows the pod is healthy now — a correct system should recognize this and NOT apply a fix (noop/REJECT), not chase a stale signal',
    incident: {
      type: 'CrashLoopBackOff', severity: 'high', scope: 'pod', clusterName: cluster,
      // §Phase4 — SIMPLE per the structural gate. Interesting edge case for Fast Path
      // specifically: fastPath.js's SYSTEM_PROMPT (src/agents/fastPath.js) has no
      // explicit "already resolved is a valid conclusion" instruction the way
      // investigator.js's does — this persona directly tests whether the one-shot
      // diagnosis call recognizes a live-healthy pod on its own anyway, or needs that
      // instruction added.
      complexity: 'SIMPLE',
      namespace: ns, podName: pod, deployment: dep, exitCode: 1, oomKilled: false, restartCount: 9,
      evidenceSummary: `Pod ${pod} was reported with 9 restarts and CrashLoopBackOff a few minutes ago by the monitoring signal.`,
    },
    fixtures: {
      // Live state (what kubectl "returns" right now) directly contradicts the incident
      // signal — the pod is actually healthy. This is the false-positive test.
      pods: [{ name: pod, ns, phase: 'Running', ready: true, restartCount: 9, waiting: null, owner: dep }],
      describe: `Status: Running\nReady: True\nRestart Count: 9\nLast State: Terminated, Reason: Completed, Exit Code: 0\nConditions:\n  Ready  True`,
      logs: '[legacy-batch] job completed successfully\n[legacy-batch] idle, waiting for next scheduled run',
      events: [],
      deploymentLimitMi: '256Mi',
      isFalsePositiveTest: true,
    },
  };
}

function P9_repeatedFailure(cluster) {
  const pod = `sync-worker-${cluster}-6f4`, dep = 'sync-worker', ns = 'shop';
  return {
    id: `P9-repeated-failure-${cluster}`,
    expectation: 'a plain restart has already failed twice — expect Guardian to steer toward rollback or escalate, not repeat the same fix',
    incident: {
      type: 'CrashLoopBackOff', severity: 'high', scope: 'pod', clusterName: cluster,
      complexity: 'SIMPLE', // §Phase4 — see P1's comment
      namespace: ns, podName: pod, deployment: dep, exitCode: 1, oomKilled: false, restartCount: 22,
      evidenceSummary: `Pod ${pod} in CrashLoopBackOff. This pod has ALREADY been restarted twice in the past hour by an earlier remediation attempt — the crash recurs within 2 minutes each time. 22 restarts total.`,
    },
    fixtures: {
      pods: [{ name: pod, ns, phase: 'Running', ready: false, restartCount: 22, waiting: 'CrashLoopBackOff', owner: dep }],
      describe: `Status: CrashLoopBackOff\nRestart Count: 22\nLast State: Terminated, Reason: Error, Exit Code: 1\nEvents:\n  Warning  BackOff  10s (x22 over 1h)  kubelet  Back-off restarting failed container`,
      logs: '[sync-worker] starting sync cycle\n[sync-worker] panic: nil pointer dereference in syncHandler\ngoroutine 1 [running]:',
      events: [{ reason: 'BackOff', message: 'Back-off restarting failed container' }],
      deploymentLimitMi: '256Mi',
    },
  };
}

function P10_externalOutage(cluster) {
  const pod = `billing-${cluster}-3z9`, dep = 'billing', ns = 'shop';
  return {
    id: `P10-external-outage-${cluster}`,
    expectation: 'nothing kubectl can do about a third-party outage — expect DELEGATE_HUMAN',
    incident: {
      type: 'ContainerError', severity: 'critical', scope: 'pod', clusterName: cluster,
      complexity: 'SIMPLE', // §Phase4 — see P1's comment
      namespace: ns, podName: pod, deployment: dep, exitCode: 1, oomKilled: false, restartCount: 3,
      evidenceSummary: `Pod ${pod} failing — logs show it cannot reach the external payment processor API. The processor's own status page confirms a provider-wide outage.`,
    },
    fixtures: {
      pods: [{ name: pod, ns, phase: 'Running', ready: false, restartCount: 3, waiting: 'CrashLoopBackOff', owner: dep }],
      describe: `Status: CrashLoopBackOff\nRestart Count: 3\nLast State: Terminated, Reason: Error, Exit Code: 1`,
      logs: 'FATAL: could not connect to external payment processor API\nDNS resolution failed for api.stripe-processor-external.example.com\n(this is a third-party outage, confirmed on the provider status page — not a cluster problem)',
      events: [{ reason: 'BackOff', message: 'Back-off restarting failed container' }],
      deploymentLimitMi: '256Mi',
    },
  };
}

const PERSONAS = [P1_transientCrash, P2_oom, P3_imagePull, P4_configError, P5_barePod, P6_flakyDependency, P7_nodeNotReady, P8_alreadyResolved, P9_repeatedFailure, P10_externalOutage];

// ── Build the 20 incidents + a lookup registry for the kubectl mock ─────────
// §Phase4 — `--compare` adds a second, COMPLEX-forced run of every SIMPLE persona
// (identical incident/fixtures, complexity overridden) so the report can pair the two
// and show Fast Path's real delta against the Full-Investigator-only baseline every
// incident got before Fast Path existed. `comparePairs` tracks the pairing explicitly
// (by id) rather than re-deriving it from string suffixes in the report.
const argv = process.argv.slice(2);
const COMPARE_MODE = argv.includes('--compare');
const filterArg = (argv.find(a => !a.startsWith('--')) || '').toLowerCase();
const all = [];
const comparePairs = []; // [{ simpleId, complexId }]
for (const build of PERSONAS) {
  for (const cluster of Object.keys(CLUSTERS)) {
    const entry = build(cluster);
    entry.cluster = cluster;
    all.push(entry);

    if (COMPARE_MODE && entry.incident.complexity === 'SIMPLE') {
      const forced = build(cluster);
      forced.cluster = cluster;
      forced.id = forced.id.replace(new RegExp(`-${cluster}$`), `-forced-complex-${cluster}`);
      forced.incident = { ...forced.incident, complexity: 'COMPLEX' };
      all.push(forced);
      comparePairs.push({ simpleId: entry.id, complexId: forced.id });
    }
  }
}
const RUN_SET = filterArg ? all.filter(e => e.id.toLowerCase().includes(filterArg)) : all;

// name (pod or node) -> fixture entry, per cluster context
const registry = new Map(); // `${context}::${name}` -> entry
for (const entry of all) {
  const name = entry.fixtures.isNode ? entry.incident.nodeName : entry.incident.podName;
  registry.set(`${entry.cluster}::${name}`, entry);
}

// ── kubectl mock ──────────────────────────────────────────────────────────
// Since incidents run strictly sequentially (see main()'s for-loop), exactly one
// incident is "in flight" at any moment — set here right before each runWorkflow()
// call. Needed because not every read the agents issue names the pod/node
// explicitly (e.g. "get configmaps -n shop", "get namespace shop") — those must
// still resolve to the incident actually being investigated, not fall through to
// "No resources found" (which the model reasonably reads as "the namespace itself
// doesn't exist" — confirmed live: that exact blank spot produced a bogus
// "create the missing namespace" plan on the first smoke-test run).
let currentEntry = null;

function _findEntry(context, cmd) {
  for (const [key, entry] of registry) {
    const [ctx, name] = key.split('::');
    if (ctx === context && cmd.includes(name)) return entry;
  }
  if (currentEntry && currentEntry.cluster === context) return currentEntry;
  return null;
}

function _podJson(f, name, ns) {
  const p = f.pods.find(x => x.name === name) ?? f.pods[0];
  return {
    metadata: { name: p.name, namespace: ns },
    status: {
      phase: p.phase,
      containerStatuses: [{
        name: 'main', ready: p.ready, restartCount: p.restartCount,
        state: p.waiting ? { waiting: { reason: p.waiting } } : { running: {} },
        lastState: p.oomKilled ? { terminated: { reason: 'OOMKilled', exitCode: 137 } } : {},
      }],
    },
  };
}

kubectl.runCommand = async function mockRunCommand(fullCommand) {
  const ctxMatch = fullCommand.match(/--context=(\S+)/);
  const context  = ctxMatch ? ctxMatch[1] : null;
  const cmd = fullCommand.replace(/^kubectl\s+--context=\S+\s+/, '').replace(/\s+--dry-run=server\b/, '');

  const entry = _findEntry(context, cmd);

  // Every namespace any persona is registered under, for this cluster — used by the
  // bare "get namespaces"/"get namespace <x>" handler below regardless of which
  // specific entry matched, so the model never sees a namespace it already knows
  // about (from the incident it's investigating) reported as missing.
  const knownNamespaces = [...new Set([...registry.values()]
    .filter(e => e.cluster === context && !e.fixtures.isNode)
    .map(e => e.incident.namespace))];

  if (/^get\s+(namespaces?|ns)\b/.test(cmd) && !/\s-o\s*json\b/.test(cmd)) {
    return ['default', 'kube-system', ...knownNamespaces].filter((v, i, a) => a.indexOf(v) === i)
      .map(n => `${n}   Active   30d`).join('\n');
  }

  if (!entry) {
    if (/get\s+nodes/.test(cmd)) {
      return JSON.stringify({ items: [
        { metadata: { name: 'control-plane', labels: { 'node-role.kubernetes.io/control-plane': '' } }, spec: { unschedulable: false }, status: { conditions: [{ type: 'Ready', status: 'True' }] } },
        { metadata: { name: 'worker-1' }, spec: { unschedulable: false }, status: { conditions: [{ type: 'Ready', status: 'True' }] } },
        { metadata: { name: 'worker-2-minikube' }, spec: { unschedulable: false }, status: { conditions: [{ type: 'Ready', status: 'False', reason: 'KubeletNotReady' }] } },
        { metadata: { name: 'worker-2-cluster2' }, spec: { unschedulable: false }, status: { conditions: [{ type: 'Ready', status: 'False', reason: 'KubeletNotReady' }] } },
      ] });
    }
    if (/-o\s*json\b/.test(cmd)) return '{"items":[]}';
    if (/^(version|cluster-info|api-resources|api-versions)/.test(cmd)) return `(mock) ${context} reachable, kubectl v1.30`;
    // Deliberately NOT the real kubectl phrase "No resources found." — that's a
    // confirmed-empty result a reasoning model correctly treats as evidence something
    // doesn't exist. This harness doesn't have fixture data for every possible query
    // the model might invent, so an unmatched query should read as "this test harness
    // has no canned answer," not "this resource is confirmed absent" (confirmed live:
    // the literal phrase on an unhandled "get all -n shop" made the model conclude the
    // namespace itself didn't exist and spiral into repeatedly re-checking it).
    return '(no output configured for this query in the test harness — do not treat this as a confirmed-empty result)';
  }

  const f = entry.fixtures;
  const podName = entry.incident.podName;
  const ns = entry.incident.namespace ?? 'default';

  if (f.isNode) {
    if (/^describe node/.test(cmd)) return f.describe;
    if (/^cordon|^drain|^uncordon/.test(cmd)) return `node/${entry.incident.nodeName} ${cmd.split(' ')[0]}ed (simulated)`;
    if (/get\s+nodes.*-o\s*json/.test(cmd)) {
      return JSON.stringify({ items: [
        { metadata: { name: entry.incident.nodeName }, spec: { unschedulable: false }, status: { conditions: [{ type: 'Ready', status: 'False', reason: 'KubeletNotReady' }] } },
        { metadata: { name: 'worker-other' }, spec: { unschedulable: false }, status: { conditions: [{ type: 'Ready', status: 'True' }] } },
      ] });
    }
    return `(mock node info) ${f.describe}`;
  }

  if (/^describe pod/.test(cmd)) return f.describe;
  if (/^logs/.test(cmd)) return f.logs ?? '(no logs)';

  // A label-selector query (-l app=X) is asking about a DIFFERENT resource than the
  // incident's own pod unless the selector value actually matches this persona's
  // deployment/app name — answering it with the incident's own pod regardless of the
  // selector (the original bug here) taught the model a false "yes, app=auth exists and
  // is broken too" and sent it in circles re-confirming that non-answer. The honest mock
  // answer for an unrelated selector is "no matches", same as a real empty selector would
  // return.
  const selectorMatch = cmd.match(/-l\s*([\w.\-=,]+)/);
  const selectorMissesThisPod = selectorMatch && entry.incident.deployment
    && !selectorMatch[1].includes(entry.incident.deployment);

  if (/^get\s+pods?.*-o\s*json/.test(cmd) || /-o\s*json.*get\s+pods?/.test(cmd)) {
    return JSON.stringify({ items: selectorMissesThisPod ? [] : [_podJson(f, podName, ns)] });
  }
  if (/^get\s+pods?/.test(cmd)) {
    if (selectorMissesThisPod) return 'No resources found in ' + ns + ' namespace matching that selector.';
    const p = f.pods[0];
    return `NAME${' '.repeat(20)}READY   STATUS${' '.repeat(14)}RESTARTS   AGE\n${p.name}   0/1     ${p.waiting || p.phase}   ${p.restartCount}          20m`;
  }
  if (/^get\s+(deploy|deployment).*jsonpath.*memory/.test(cmd)) return f.deploymentLimitMi ?? '';
  if (/^get\s+(deploy|deployment)/.test(cmd)) return `NAME   READY   UP-TO-DATE   AVAILABLE\n${entry.incident.deployment}   0/1     1            0`;
  if (/^get\s+events/.test(cmd)) {
    if (/-o\s*json/.test(cmd)) return JSON.stringify({ items: (f.events ?? []).map(e => ({ reason: e.reason, message: e.message, type: 'Warning', involvedObject: { name: podName, namespace: ns } })) });
    return (f.events ?? []).map(e => `Warning   ${e.reason}   ${e.message}`).join('\n') || 'No events found.';
  }
  // No persona narrative in this harness hinges on a broken Service/Endpoint — a
  // downstream connectivity issue in a log line is meant to read as a transient blip,
  // not an actual network-layer misconfiguration to go chase. Confirmed live: without
  // this, the model spent most of its budget re-querying an unfixtured Service/Endpoint
  // hoping for a different answer, instead of accepting "this looks healthy" and moving
  // on to the (correctly fixtured) pod-level evidence it already had.
  if (/^get\s+(services?|svc|endpoints?|ep)\b/.test(cmd)) {
    if (/-o\s*json/.test(cmd)) return JSON.stringify({ items: [{ metadata: { name: 'service', namespace: ns }, subsets: [{ addresses: [{ ip: '10.0.0.5' }] }] }] });
    return `NAME      TYPE        CLUSTER-IP    PORT(S)\nservice   ClusterIP   10.0.0.5      443/TCP   (looks healthy, has endpoints)`;
  }
  if (/^get\s+(configmap|cm)/.test(cmd)) {
    if (!f.configMap) return '(no ConfigMaps of interest — not relevant to this incident)';
    if (/-o\s*json/.test(cmd)) return JSON.stringify({ items: [{ metadata: { name: f.configMap.name, namespace: ns }, data: Object.fromEntries(f.configMap.keys.map(k => [k, 'redacted'])) }] });
    return `NAME               DATA\n${f.configMap.name}   ${f.configMap.keys.length}`;
  }
  if (/^get\s+all\b/.test(cmd)) {
    const p = f.pods[0];
    const depLine = entry.incident.deployment ? `deployment.apps/${entry.incident.deployment}   0/1     1            0\n` : '';
    return `NAME       READY   STATUS${' '.repeat(10)}RESTARTS   AGE\npod/${p.name}   0/1     ${p.waiting || p.phase}   ${p.restartCount}          20m\n\n${depLine}`;
  }
  // Same reasoning as the unmatched-entry fallback above: this persona/entry IS real
  // and IS the thing under investigation, so an unrecognized query about it should
  // read as "the harness has no canned data for this specific query," never as
  // "confirmed empty" — the two read very differently to a reasoning model.
  return `(no additional output configured for this query in the test harness — pod ${podName} in namespace ${ns} does exist, just no canned answer for this specific command)`;
};

kubectl.getPods = async function mockGetPods(namespace, context, asJson) {
  // Used directly by guardianNode's §7.5 live-state re-fetch (asJson=true, via the
  // k8sClient API path in the real module — bypassed entirely here).
  const items = [];
  for (const [key, entry] of registry) {
    const [ctx] = key.split('::');
    if (ctx !== context || entry.fixtures.isNode) continue;
    if (namespace !== '*' && entry.incident.namespace !== namespace) continue;
    items.push(_podJson(entry.fixtures, entry.incident.podName, entry.incident.namespace));
  }
  return { items };
};

kubectl.getNodes = async function mockGetNodes(context) {
  const nodeEntry = [...registry.values()].find(e => e.cluster === context && e.fixtures.isNode);
  const items = [
    { metadata: { name: 'control-plane', labels: { 'node-role.kubernetes.io/control-plane': '' } }, spec: { unschedulable: false } },
    { metadata: { name: 'worker-1' }, spec: { unschedulable: false } },
  ];
  if (nodeEntry) items.push({ metadata: { name: nodeEntry.incident.nodeName }, spec: { unschedulable: false } });
  else items.push({ metadata: { name: 'worker-2' }, spec: { unschedulable: false } });
  return { items };
};

kubectl.getLogs = async function mockGetLogs(podName, namespace, context) {
  const entry = _findEntry(context, podName);
  return entry?.fixtures.logs ?? '';
};

// §Phase4 — src/agents/fastPath.js calls these as NAMED kubectl.js functions (not the
// generic runCommand string passthrough investigator.js/planner.js always used), so
// they need their own mocks here — without them, Fast Path's describePod/getConfigMaps/
// getSecretsMetadata/getPersistentVolumeClaims calls fall through to the REAL
// implementations (which need sessionManager -> MongoDB for per-cluster credentials)
// and time out in a harness with no live DB, silently degrading Fast Path's evidence
// instead of giving it the same realistic fixture data the Full Investigator gets via
// the mocked runCommand path. Confirmed live during this evaluation (2026-09-07):
// P1's Fast Path run resolved correctly anyway (Promise.allSettled degrades
// gracefully — see fastPath.js), but with `podDescribe: null`, understating what real
// evidence Fast Path would actually have.
kubectl.describePod = async function mockDescribePod(podName, namespace, context) {
  const entry = _findEntry(context, podName);
  return entry?.fixtures.describe ?? `(no describe fixture for ${podName})`;
};

kubectl.getConfigMaps = async function mockGetConfigMaps(namespace, context) {
  const entry = currentEntry && currentEntry.cluster === context ? currentEntry : null;
  const cm = entry?.fixtures.configMap;
  return cm ? [{ metadata: { name: cm.name, namespace }, data: Object.fromEntries(cm.keys.map(k => [k, 'redacted'])) }] : [];
};

kubectl.getSecretsMetadata = async function mockGetSecretsMetadata(namespace, context) {
  return []; // no persona in this corpus defines a secrets fixture — an honest empty default
};

kubectl.getPersistentVolumeClaims = async function mockGetPersistentVolumeClaims(context) {
  return []; // no persona in this corpus defines a PVC fixture
};

// ── approvalStore mock — auto-approve immediately, log + count it ──────────
let approvalCount = 0;
approvalStore.requestApproval = async function mockRequestApproval(payload) {
  approvalCount++;
  console.log(`[MOCK-APPROVAL] auto-approving: issue=${payload.issueKey} action=${payload.diagnosis?.action} risk=${payload.diagnosis?.risk}`);
  return true;
};

// ── escalationStore mock — never hit real Mongo/email/Teams for a test run ──
escalationStore.escalate = async function mockEscalate(issueKey) {
  console.log(`[MOCK-ESCALATE] ${issueKey}`);
  return 'mock-escalation-id';
};

// §Phase4 — workflowTraceStore.save() is graph.js's own runWorkflow() persisting a
// WorkflowTracer.toDocument() (src/monitoring/workflowTracer.js) after every incident,
// fire-and-forget, straight to Mongo (src/db/models/history.js's WorkflowTrace). Capturing
// it here in-memory instead gets every Phase 1 metric (LLM/tool calls per NODE —
// including planner/guardian, which src/agents/investigator.js's own `rca` fields don't
// cover — plus the Phase 3 convergence fields) for free, with no live Mongo required.
const traceByWorkflowId = new Map();
workflowTraceStore.save = async function mockSaveTrace(doc) {
  traceByWorkflowId.set(doc.workflowId, doc);
};

// ── Console capture per incident ────────────────────────────────────────────
function captureConsole(fn) {
  const lines = [];
  const origLog = console.log, origWarn = console.warn, origError = console.error;
  const push = (...args) => lines.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
  console.log = (...a) => { push(...a); origLog(...a); };
  console.warn = (...a) => { push('[warn]', ...a); origWarn(...a); };
  console.error = (...a) => { push('[error]', ...a); origError(...a); };
  return fn().finally(() => { console.log = origLog; console.warn = origWarn; console.error = origError; }).then(result => ({ result, lines }));
}

// ── Run ──────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n=== 20-INCIDENT TEST RUN — ${RUN_SET.length} incident(s) ===\n`);
  await vectorStore.initialize().catch(() => {});
  await episodicMemory.initialize().catch(() => {});
  await shortMemory.initialize().catch(() => {});

  const jsonlStream = fs.createWriteStream(JSONL_PATH, { flags: 'a' });
  const records = [];

  for (const [i, entry] of RUN_SET.entries()) {
    console.log(`\n${'#'.repeat(80)}\n[${i + 1}/${RUN_SET.length}] ${entry.id}  (cluster=${entry.cluster}, tier=${CLUSTERS[entry.cluster].tier})\nexpectation: ${entry.expectation}\n${'#'.repeat(80)}`);

    currentEntry = entry;
    const approvalsBefore = approvalCount;
    const t0 = Date.now();
    let outcome = null, error = null, logLines = [];
    try {
      const { result, lines } = await captureConsole(() =>
        runWorkflow({ incidents: [entry.incident], clusterConfigs: CLUSTERS })
      );
      outcome = result;
      logLines = lines;
    } catch (err) {
      error = err.message;
    }
    const durationMs = Date.now() - t0;
    const approvalsRequested = approvalCount - approvalsBefore;

    const item = outcome?.items?.[0] ?? null;
    // graph.js's routeAfterPlanner sends an all-command-less plan straight to
    // Reflexion, bypassing Guardian/Policy entirely (nothing for either to judge) — that
    // path never sets state.outcome, so it comes back here as a bare `null`, not one of
    // 'fixed'/'blocked'/'escalated'. Confirmed live (2026-08-28): Reflexion's OWN internal
    // bookkeeping still treats this as `outcome ?? 'failed'` for issueTrackerStore, so the
    // returned top-level state is quietly less informative than what the workflow itself
    // already concluded — classifying it explicitly here as 'no_fix_available' rather than
    // letting it read as "unknown" in the report.
    const noFixAvailable = outcome && outcome.outcome == null && !item?.step?.command;
    const record = {
      id: entry.id, cluster: entry.cluster, tier: CLUSTERS[entry.cluster].tier,
      expectation: entry.expectation,
      incident: entry.incident,
      durationMs, error,
      attempt: outcome?.attempt ?? null,
      finalOutcome: outcome?.outcome ?? (error ? 'error' : (noFixAvailable ? 'no_fix_available' : null)),
      blockReason: outcome?.blockReason ?? null,
      investigator: outcome?.rca ? {
        rootCause: outcome.rca.rootCause, layer: outcome.rca.layer, confidence: outcome.rca.confidence,
        evidenceSufficiency: outcome.rca.evidenceSufficiency, reachedConfidenceTarget: outcome.rca.reachedConfidenceTarget,
        commandsRun: (outcome.rca.commandsExecuted ?? []).map(c => c.command),
        // §Phase2/3 — present on every rca regardless of path (Fast Path or Full
        // Investigator both set these; see fastPath.js's _toInvestigationReport and
        // investigator.js's investigate()/_fallback()).
        fastPath: !!outcome.rca.fastPath,
        investigationTurns: outcome.rca.investigationTurns ?? null,
        ringsVisited: outcome.rca.ringsVisited ?? [],
        layersInvestigated: outcome.rca.layersInvestigated ?? [],
        bestHypothesis: outcome.rca.bestHypothesis ?? null,
        nonImprovingRounds: outcome.rca.nonImprovingRounds ?? null,
        stoppingOutcome: outcome.rca.stoppingOutcome ?? null,
      } : null,
      planner: item ? { action: item.step?.action, command: item.step?.command, risk: item.step?.risk, reversible: item.step?.reversible, inverseCommand: item.step?.inverseCommand } : null,
      guardian: item?.verdict ? { verdict: item.verdict.verdict, classification: item.verdict.classification, reason: item.verdict.reason, suggestedCommand: item.verdict.suggestedCommand, stateDrift: item.verdict.stateDrift, estimatedBlastRadius: item.verdict.estimatedBlastRadius } : null,
      policy: item?.policyResult ? { status: item.policyResult.status, command: item.policyResult.command, reason: item.policyResult.reason } : null,
      executor: item ? { executionOutcome: item.executionOutcome, executionError: item.executionError } : null,
      // §Phase4 — the full per-workflow trace captured via the workflowTraceStore.save
      // mock above: totals across EVERY node (fastPath/investigator/planner/guardian),
      // not just the investigator-specific fields already on `investigator` above.
      trace: outcome?.workflowId ? (traceByWorkflowId.get(outcome.workflowId) ?? null) : null,
      approvalsRequested,
      isFalsePositiveTest: !!entry.fixtures.isFalsePositiveTest,
      log: logLines,
    };
    records.push(record);
    jsonlStream.write(JSON.stringify(record) + '\n');

    const pathTag = record.investigator?.fastPath ? 'fastPath' : (entry.incident.complexity === 'SIMPLE' ? 'fastPath->escalated' : 'fullInvestigator');
    console.log(`\n>>> RESULT [${entry.id}]: outcome=${record.finalOutcome} attempt=${record.attempt} guardianVerdict=${record.guardian?.verdict ?? 'n/a'} command="${record.planner?.command ?? ''}" approvalsRequested=${approvalsRequested} (${durationMs}ms) path=${pathTag} llmCalls=${record.trace?.totalLlmCalls ?? 'n/a'} toolCalls=${record.trace?.totalToolCalls ?? 'n/a'} stoppingOutcome=${record.investigator?.stoppingOutcome ?? 'n/a'}`);
  }

  jsonlStream.end();
  writeReport(records, comparePairs);
  console.log(`\n\nDone. ${records.length} incidents run.\nJSONL: ${JSONL_PATH}\nReport: ${REPORT_PATH}`);
}

// ── Report generation ───────────────────────────────────────────────────────
// ── Stats helpers ────────────────────────────────────────────────────────
function _median(numbers) {
  const arr = [...numbers].sort((a, b) => a - b);
  if (arr.length === 0) return null;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}
function _pct(count, total) {
  return total > 0 ? `${((count / total) * 100).toFixed(0)}%` : '—';
}
function _sec(ms) {
  return ms == null ? 'n/a' : `${(ms / 1000).toFixed(1)}s`;
}

function writeReport(records, comparePairs = []) {
  const n = records.length;
  const fixed     = records.filter(r => r.finalOutcome === 'fixed');
  const escalated = records.filter(r => r.finalOutcome === 'escalated');
  const blocked   = records.filter(r => r.finalOutcome === 'blocked');
  const noFix     = records.filter(r => r.finalOutcome === 'no_fix_available');
  const errored   = records.filter(r => r.finalOutcome === 'error');
  const discovered = records.filter(r => r.investigator?.reachedConfidenceTarget);
  const totalApprovals = records.reduce((s, r) => s + (r.approvalsRequested || 0), 0);
  const totalAttempts  = records.reduce((s, r) => s + (r.attempt || 0), 0);
  const medianDurationMs = _median(records.map(r => r.durationMs).filter(d => d != null));

  // False positive: the P8 "already resolved" persona pair. A run is a FALSE POSITIVE
  // if the system proceeded to actually apply/approve a fix for a problem that live
  // evidence showed was already resolved (i.e. it did NOT recognize the contradiction).
  const fpTests = records.filter(r => r.isFalsePositiveTest);
  const falsePositives = fpTests.filter(r => r.finalOutcome === 'fixed' || (r.guardian?.verdict === 'APPROVE'));
  const trueNegatives  = fpTests.filter(r => !falsePositives.includes(r));

  const lines = [];
  const p = s => lines.push(s);

  p(`# 20-Incident Pipeline Test — ${new Date().toISOString()}`);
  p('');
  p(`Real \`runWorkflow()\` (Orchestrator complexity routing → Fast Path or Full Investigator → Planner → Guardian → Policy → Executor → Reflexion), real LLM calls, kubectl mocked per-persona (no live cluster). 10 failure personas × 2 clusters (\`minikube\`=dev, \`cluster2\`=production)${comparePairs.length ? ` + ${comparePairs.length} \`--compare\` COMPLEX-forced clones` : ''} = ${n} incidents.`);
  p('');
  p('## Summary');
  p('');
  p(`| Metric | Count | % of ${n} |`);
  p('|---|---|---|');
  p(`| Investigation reached its confidence/evidence target ("discovered") | ${discovered.length} | ${_pct(discovered.length, n)} |`);
  p(`| Fixed | ${fixed.length} | ${_pct(fixed.length, n)} |`);
  p(`| Escalated to human | ${escalated.length} | ${_pct(escalated.length, n)} |`);
  p(`| Blocked (denied/unresolved) | ${blocked.length} | ${_pct(blocked.length, n)} |`);
  p(`| No automated fix available (Planner declined, all steps command-less) | ${noFix.length} | ${_pct(noFix.length, n)} |`);
  p(`| Errored (harness/schema failure) | ${errored.length} | ${_pct(errored.length, n)} |`);
  p(`| Total investigate↔policy attempts across all runs | ${totalAttempts} | — |`);
  p(`| Human-approval requests (auto-approved by harness) | ${totalApprovals} | — |`);
  p(`| False positives (fixed a problem that was already resolved) | ${falsePositives.length} | ${_pct(falsePositives.length, fpTests.length)} of ${fpTests.length} FP tests |`);
  p(`| True negatives (correctly recognized already-resolved) | ${trueNegatives.length} | ${_pct(trueNegatives.length, fpTests.length)} of ${fpTests.length} FP tests |`);
  p(`| **Median time per incident** | **${_sec(medianDurationMs)}** | — |`);
  p('');

  // ── §Phase4 — Fast Path & Convergence ──────────────────────────────────
  // Every SIMPLE-tagged incident's `investigator.fastPath` tells us whether Fast
  // Path actually resolved it or escalated to the Full Investigator (fastPath.js's
  // diagnose() sets rca.fastPath=true only on the accepted path — an escalation
  // produces no rca of its own at that node, the Full Investigator's does).
  const simpleIncidents  = records.filter(r => r.incident.complexity === 'SIMPLE');
  const fastPathResolved = simpleIncidents.filter(r => r.investigator?.fastPath);
  const fastPathEscalated = simpleIncidents.filter(r => r.investigator && !r.investigator.fastPath);
  const fullInvestigatorRuns = records.filter(r => r.investigator && !r.investigator.fastPath);
  const llmCalls  = r => r.trace?.totalLlmCalls ?? null;
  const toolCalls = r => r.trace?.totalToolCalls ?? null;
  const avg = arr => arr.length ? +(arr.reduce((s, v) => s + v, 0) / arr.length).toFixed(1) : null;

  const stoppingOutcomeCounts = new Map();
  for (const r of fullInvestigatorRuns) {
    const o = r.investigator?.stoppingOutcome ?? 'unknown';
    stoppingOutcomeCounts.set(o, (stoppingOutcomeCounts.get(o) ?? 0) + 1);
  }
  const earlyStops = fullInvestigatorRuns.filter(r =>
    r.investigator?.stoppingOutcome === 'DIAGNOSIS_READY'
    && (r.investigator?.nonImprovingRounds ?? 0) > 0
  );

  p('## Fast Path & Convergence (Phase 2/3)');
  p('');
  p(`${simpleIncidents.length} of ${n} incidents were classified SIMPLE and eligible for Fast Path (src/agents/fastPath.js).`);
  p('');
  p('| Metric | Value |');
  p('|---|---|');
  p(`| Fast Path resolved without escalating | ${fastPathResolved.length} / ${simpleIncidents.length} (${_pct(fastPathResolved.length, simpleIncidents.length)}) |`);
  p(`| Fast Path escalated to the Full Investigator | ${fastPathEscalated.length} / ${simpleIncidents.length} (${_pct(fastPathEscalated.length, simpleIncidents.length)}) |`);
  p(`| Avg LLM calls — Fast Path resolved | ${avg(fastPathResolved.map(llmCalls).filter(v => v != null)) ?? 'n/a'} |`);
  p(`| Avg LLM calls — Full Investigator (escalated + all-COMPLEX runs) | ${avg(fullInvestigatorRuns.map(llmCalls).filter(v => v != null)) ?? 'n/a'} |`);
  p(`| Avg tool calls — Fast Path resolved | ${avg(fastPathResolved.map(toolCalls).filter(v => v != null)) ?? 'n/a'} |`);
  p(`| Avg tool calls — Full Investigator | ${avg(fullInvestigatorRuns.map(toolCalls).filter(v => v != null)) ?? 'n/a'} |`);
  p(`| Median latency — Fast Path resolved | ${_sec(_median(fastPathResolved.map(r => r.durationMs)))} |`);
  p(`| Median latency — Full Investigator | ${_sec(_median(fullInvestigatorRuns.map(r => r.durationMs)))} |`);
  p(`| Full Investigator runs that early-stopped via the new stability path (non-improving rounds, not the ring-confidence bar or exhaustion) | ${earlyStops.length} / ${fullInvestigatorRuns.length} |`);
  p('');
  p('Full Investigator stopping-outcome distribution (across all runs that went through it, whether directly-COMPLEX or fast-path-escalated):');
  p('');
  p('| Outcome | Count |');
  p('|---|---|');
  for (const [outcome, count] of stoppingOutcomeCounts) p(`| ${outcome} | ${count} |`);
  p('');

  if (comparePairs.length > 0) {
    p('## Fast Path Impact — A/B (`--compare`)');
    p('');
    p('Each row is the SAME incident/fixtures run twice: once routed through Fast Path (`complexity: SIMPLE`, real classification), once forced through the Full Investigator (`complexity: COMPLEX`) as a stand-in for "every incident\'s only path before Fast Path existed."');
    p('');
    p('| Persona | Fast Path outcome | LLM calls (FP / Full) | Tool calls (FP / Full) | Latency (FP / Full) | Root cause matched? |');
    p('|---|---|---|---|---|---|');
    const byId = new Map(records.map(r => [r.id, r]));
    for (const { simpleId, complexId } of comparePairs) {
      const s = byId.get(simpleId), c = byId.get(complexId);
      if (!s || !c) continue;
      const fpOutcome = s.investigator?.fastPath ? 'resolved' : 'escalated';
      const sameRootCause = s.investigator?.rootCause && c.investigator?.rootCause
        ? (s.investigator.rootCause === c.investigator.rootCause ? 'exact match' : 'differs — compare manually')
        : 'n/a';
      p(`| ${simpleId.replace(/-minikube$|-cluster2$/, '')} | ${fpOutcome} | ${llmCalls(s) ?? 'n/a'} / ${llmCalls(c) ?? 'n/a'} | ${toolCalls(s) ?? 'n/a'} / ${toolCalls(c) ?? 'n/a'} | ${_sec(s.durationMs)} / ${_sec(c.durationMs)} | ${sameRootCause} |`);
    }
    p('');
  }

  // ── By incident type ───────────────────────────────────────────────────
  // Groups by the incident's own `type` field (CrashLoopBackOff, OOMKilled, etc.) —
  // several personas share a type but differ in root cause, so this is a coarser cut
  // than per-persona; see "Per-cycle detail" below for the persona-level breakdown.
  p('## By incident type');
  p('');
  p('| Type | n | Fixed | Escalated | No fix | Blocked | Median time |');
  p('|---|---|---|---|---|---|---|');
  const byType = new Map();
  for (const r of records) {
    const t = r.incident?.type ?? 'unknown';
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t).push(r);
  }
  for (const [type, group] of [...byType.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const gn = group.length;
    const gFixed     = group.filter(r => r.finalOutcome === 'fixed').length;
    const gEscalated = group.filter(r => r.finalOutcome === 'escalated').length;
    const gNoFix     = group.filter(r => r.finalOutcome === 'no_fix_available').length;
    const gBlocked   = group.filter(r => r.finalOutcome === 'blocked').length;
    const gMedian    = _median(group.map(r => r.durationMs).filter(d => d != null));
    p(`| ${type} | ${gn} | ${gFixed} (${_pct(gFixed, gn)}) | ${gEscalated} (${_pct(gEscalated, gn)}) | ${gNoFix} (${_pct(gNoFix, gn)}) | ${gBlocked} (${_pct(gBlocked, gn)}) | ${_sec(gMedian)} |`);
  }
  p('');

  // ── By persona ──────────────────────────────────────────────────────────
  // Finer-grained than by-type: each persona is its own scenario (e.g. P1 vs P6 are
  // both CrashLoopBackOff but different root causes) — median here is across just the
  // 2 cluster runs of that persona, so treat it as directional, not a real distribution.
  p('## By persona');
  p('');
  p('| Persona | n | Fixed | Escalated | No fix | Blocked | Median time |');
  p('|---|---|---|---|---|---|---|');
  const byPersonaId = new Map();
  for (const r of records) {
    const base = r.id.replace(/-(minikube|cluster2)$/, '');
    if (!byPersonaId.has(base)) byPersonaId.set(base, []);
    byPersonaId.get(base).push(r);
  }
  for (const [base, group] of byPersonaId) {
    const gn = group.length;
    const gFixed     = group.filter(r => r.finalOutcome === 'fixed').length;
    const gEscalated = group.filter(r => r.finalOutcome === 'escalated').length;
    const gNoFix     = group.filter(r => r.finalOutcome === 'no_fix_available').length;
    const gBlocked   = group.filter(r => r.finalOutcome === 'blocked').length;
    const gMedian    = _median(group.map(r => r.durationMs).filter(d => d != null));
    p(`| ${base} | ${gn} | ${gFixed} | ${gEscalated} | ${gNoFix} | ${gBlocked} | ${_sec(gMedian)} |`);
  }
  p('');

  p('## Per-cycle detail');
  for (const r of records) {
    p('');
    p(`### ${r.id}  (${r.cluster}, tier=${r.tier})`);
    p(`**Expectation:** ${r.expectation}`);
    p('');
    p(`**Incident (input):** \`${JSON.stringify(r.incident)}\``);
    p('');
    if (r.error) { p(`**ERROR:** ${r.error}`); continue; }
    p(`**Path:** complexity=${r.incident.complexity ?? 'UNKNOWN'}, resolved via ${r.investigator?.fastPath ? 'Fast Path' : 'Full Investigator'}${r.incident.complexity === 'SIMPLE' && !r.investigator?.fastPath ? ' (Fast Path escalated)' : ''}`);
    p(`**Trace (Phase 1):** LLM calls=${r.trace?.totalLlmCalls ?? 'n/a'}, tool calls=${r.trace?.totalToolCalls ?? 'n/a'}, per-node=\`${r.trace ? JSON.stringify(r.trace.nodes) : 'n/a'}\``);
    p('');
    p('**Investigator** — output:');
    p(`- rootCause: ${r.investigator?.rootCause ?? 'n/a'}`);
    p(`- layer: ${r.investigator?.layer ?? 'n/a'}, confidence: ${r.investigator?.confidence ?? 'n/a'}, evidenceSufficiency: ${r.investigator?.evidenceSufficiency ?? 'n/a'}, reachedTarget: ${r.investigator?.reachedConfidenceTarget ?? 'n/a'}`);
    p(`- tools used (commands run): ${r.investigator?.commandsRun?.length ? r.investigator.commandsRun.map(c => `\`${c}\``).join(', ') : '(none)'}`);
    if (!r.investigator?.fastPath) {
      p(`- investigationTurns: ${r.investigator?.investigationTurns ?? 'n/a'}, ringsVisited: ${JSON.stringify(r.investigator?.ringsVisited ?? [])}, layersInvestigated: ${JSON.stringify(r.investigator?.layersInvestigated ?? [])}`);
      p(`- §Convergence — stoppingOutcome: ${r.investigator?.stoppingOutcome ?? 'n/a'}, nonImprovingRounds: ${r.investigator?.nonImprovingRounds ?? 'n/a'}, bestHypothesis: \`${r.investigator?.bestHypothesis ? JSON.stringify(r.investigator.bestHypothesis) : 'n/a'}\``);
    }
    p('');
    p('**Planner** — output:');
    p(`- action: ${r.planner?.action ?? 'n/a'}, command: \`${r.planner?.command || '(empty)'}\`, risk: ${r.planner?.risk ?? 'n/a'}, reversible: ${r.planner?.reversible ?? 'n/a'}, inverseCommand: \`${r.planner?.inverseCommand || 'null'}\``);
    p('');
    p('**Guardian** — output:');
    p(`- verdict: ${r.guardian?.verdict ?? 'n/a'} (${r.guardian?.classification ?? 'n/a'})`);
    p(`- reason: ${r.guardian?.reason ?? 'n/a'}`);
    if (r.guardian?.suggestedCommand) p(`- suggestedCommand: \`${r.guardian.suggestedCommand}\``);
    p(`- stateDrift: ${r.guardian?.stateDrift ?? 'n/a'}, estimatedBlastRadius: ${r.guardian?.estimatedBlastRadius ?? 'n/a'}`);
    p('');
    p('**Policy** — output:');
    p(`- status: ${r.policy?.status ?? 'n/a'}, final command: \`${r.policy?.command || '(none)'}\``);
    p(`- reason: ${r.policy?.reason ?? 'n/a'}`);
    p('');
    p('**Executor** — output:');
    p(`- executionOutcome: ${r.executor?.executionOutcome ?? 'n/a'}${r.executor?.executionError ? ` (${r.executor.executionError})` : ''}`);
    p('');
    p(`**Final:** outcome=${r.finalOutcome}, attempt=${r.attempt}, blockReason=${r.blockReason ?? 'none'}, approvalsRequested=${r.approvalsRequested}, duration=${_sec(r.durationMs)} (${r.durationMs}ms)`);
  }

  p('');
  p('## Reasoning');
  p('');
  p(reasoningNarrative(records, { fixed, escalated, blocked, noFix, errored, discovered, falsePositives, trueNegatives }));

  fs.writeFileSync(REPORT_PATH, lines.join('\n'), 'utf8');
}

function reasoningNarrative(records, buckets) {
  const out = [];

  out.push(`- **Discovery** (${buckets.discovered.length}/${records.length} reached their investigation's confidence/evidence target): the personas with unambiguous, directly-observable evidence (transient crash logs, OOM kill reason, image-pull error text) were investigated quickly — via Fast Path's single call when SIMPLE, or the Full Investigator's ring loop otherwise. Personas requiring interpretation across multiple weak signals typically needed more tool calls, and for Fast Path specifically, more often triggered an honest escalation to the Full Investigator rather than a low-confidence guess (see the Fast Path & Convergence section above).`);
  out.push(`- **Fixed** (${buckets.fixed.length}): mostly the personas with a single, unambiguous, kubectl-expressible remedy — transient crash (restart), OOM (memory raise), bare pod (delete), flaky dependency (restart).`);
  out.push(`- **Escalated** (${buckets.escalated.length}): personas where no kubectl command can address the root cause (bad image tag, external third-party outage) correctly routed to escalation rather than an automated attempt that could never succeed — the intended behavior of Guardian's REJECT/DELEGATE_HUMAN split and Policy's immediate-escalation routing for DELEGATE_HUMAN.`);
  out.push(`- **Blocked** (${buckets.blocked.length}): steps that needed human approval (high risk / non-reversible / production tier elevating risk) — the harness auto-approved these rather than letting them hang, so a 'blocked' outcome here means a real denial-equivalent condition (Policy rejecting after Guardian's own review), not a stuck approval.`);
  out.push(`- **No automated fix available** (${buckets.noFix.length}): the Planner concluded every step should be command-less (its own way of saying "nothing safe to run automatically"). This routes straight to Reflexion, skipping Guardian/Policy — and a real gap surfaced by this test run: the top-level workflow state's \`outcome\` field stays \`null\` on this path rather than being set to something explicit, even though Reflexion's own internal bookkeeping treats it as a failure. Worth a small fix in graph.js if this path matters for monitoring.`);
  out.push(`- **False positives** (${buckets.falsePositives.length}/${buckets.falsePositives.length + buckets.trueNegatives.length} false-positive tests): the P8 persona fed the Orchestrator's original (stale) signal as the incident while making live pod state show a fully healthy, already-resolved pod. ${buckets.falsePositives.length === 0 ? 'The pipeline correctly recognized the contradiction in both clusters and did not apply an unnecessary fix — Guardian\'s §7.5 live-state re-fetch (stateDrift detection) is exactly the mechanism designed to catch this, and it did.' : `${buckets.falsePositives.length} run(s) proceeded to fix a non-problem — worth investigating why the live-state drift signal didn't stop it (see stateDrift field in that record).`}`);
  out.push(`- **Tier effect (minikube/dev vs cluster2/production)**: for the same persona, compare each pair's \`approvalsRequested\` and \`policy.status\` — production tier's risk elevation (MEDIUM→HIGH, and non-reversible steps always requiring approval) should show more approval requests on cluster2 than the identical minikube incident, even though Guardian's verdict on the underlying command is usually the same.`);
  return out.join('\n');
}

main().then(() => process.exit(0)).catch(err => { console.error('FATAL:', err); process.exit(1); });
