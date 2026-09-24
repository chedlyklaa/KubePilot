#!/usr/bin/env node
// =============================================================================
// scripts/generate-pod-fixtures.js — synthetic "kubectl get pods/nodes/events -o json"
// snapshot generator, spread across a configurable number of namespaces, for stress-
// testing OrchestratorAgent's classification + namespace-grouping dispatch behavior
// (see scripts/test-orchestrator-visualize.js, which consumes this).
//
// Deterministic when a --seed is given (same seed -> same fixture, so a run can be
// reproduced) — otherwise seeds from the current time.
//
// Usage (as a CLI, prints the fixture as JSON):
//   node scripts/generate-pod-fixtures.js --namespaces=5 --perNamespace=4 --failureRate=0.5 --seed=42
//
// Usage (as a module):
//   const { generateFixture } = require('./generate-pod-fixtures');
//   const fixture = generateFixture({ namespaceCount: 5, podsPerNamespace: 4, failureRate: 0.5, seed: 42 });
// =============================================================================
'use strict';

// mulberry32 — small, fast, seedable PRNG (Math.random() can't be seeded).
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const APP_NAMES = [
  'api', 'worker', 'cache', 'auth', 'billing', 'frontend',
  'scheduler', 'queue-consumer', 'notifier', 'gateway',
];

function randHex(rand, len) {
  let s = '';
  for (let i = 0; i < len; i++) s += Math.floor(rand() * 16).toString(16);
  return s;
}

// Each failure mode returns the containerStatuses[0] override + an optional matching
// Warning event — mirrors the symptom+event pairing the real classifier is told
// (SYSTEM_PROMPT in orchestratorAgent.js) to merge into ONE incident, not two.
const FAILURE_MODES = {
  healthy: (rand, ctx) => ({
    phase: 'Running',
    containerStatus: { ready: true, restartCount: 0 },
    event: null,
  }),
  crashloop: (rand, ctx) => {
    const restarts = 3 + Math.floor(rand() * 20);
    return {
      phase: 'Running',
      containerStatus: {
        ready: false, restartCount: restarts,
        state: { waiting: { reason: 'CrashLoopBackOff' } },
        lastState: { terminated: { exitCode: 1, reason: 'Error' } },
      },
      event: {
        reason: 'BackOff', count: restarts,
        message: `Back-off restarting failed container ${ctx.containerName} in pod ${ctx.podName}`,
      },
    };
  },
  oom: (rand, ctx) => {
    const restarts = 1 + Math.floor(rand() * 6);
    return {
      phase: 'Running',
      containerStatus: {
        ready: false, restartCount: restarts,
        state: { waiting: { reason: 'CrashLoopBackOff' } },
        lastState: { terminated: { exitCode: 137, reason: 'OOMKilled' } },
      },
      event: {
        reason: 'OOMKilling', count: restarts,
        message: `Memory cgroup out of memory: Killed process ${ctx.containerName}`,
      },
    };
  },
  imagepull: (rand, ctx) => ({
    phase: 'Pending',
    containerStatus: {
      ready: false, restartCount: 0,
      state: { waiting: { reason: 'ImagePullBackOff' } },
    },
    event: {
      reason: 'Failed', count: 1 + Math.floor(rand() * 5),
      message: `Failed to pull image "${ctx.appName}:bad-tag": not found`,
    },
  }),
  pending: (rand, ctx) => ({
    phase: 'Pending',
    containerStatus: null, // unscheduled — no containerStatuses yet, same as a real Pending pod
    event: {
      reason: 'FailedScheduling', count: 1 + Math.floor(rand() * 8),
      message: '0/3 nodes are available: 3 Insufficient cpu.',
    },
  }),
};

const FAILURE_MODE_NAMES = Object.keys(FAILURE_MODES);

function buildPod(rand, namespace, nodeName, forcedMode) {
  const appName  = APP_NAMES[Math.floor(rand() * APP_NAMES.length)];
  const rsHash   = randHex(rand, 5);
  const podHash  = randHex(rand, 5);
  const rsName   = `${appName}-${rsHash}`;
  const podName  = `${rsName}-${podHash}`;
  const mode     = forcedMode ?? FAILURE_MODE_NAMES[Math.floor(rand() * FAILURE_MODE_NAMES.length)];

  const { phase, containerStatus, event } = FAILURE_MODES[mode](rand, { podName, appName, containerName: appName });

  const pod = {
    metadata: {
      name: podName,
      namespace,
      ownerReferences: [{ kind: 'ReplicaSet', name: rsName }],
    },
    spec: { nodeName },
    status: {
      phase,
      containerStatuses: containerStatus ? [{ name: appName, ...containerStatus }] : [],
    },
  };

  const evt = event ? {
    type: 'Warning',
    reason: event.reason,
    message: event.message,
    count: event.count,
    lastTimestamp: new Date().toISOString(),
    involvedObject: { kind: 'Pod', name: podName, namespace },
  } : null;

  return { pod, event: evt, mode, appName };
}

// ── Public API ───────────────────────────────────────────────────────────────
function generateFixture(opts = {}) {
  const {
    namespaceCount   = 3,
    podsPerNamespace = 3,
    nodeCount        = 2,
    failureRate      = 0.5,   // fraction of pods NOT forced healthy (rest are random failure modes)
    nodeFailureRate  = 0,     // fraction of nodes forced NotReady
    namespaces       = null,  // explicit namespace names; overrides namespaceCount if given
    seed             = Date.now() >>> 0,
  } = opts;

  const rand = mulberry32(seed);
  const nsNames = namespaces ?? Array.from({ length: namespaceCount }, (_, i) => `ns-${i + 1}`);
  const nodeNames = Array.from({ length: nodeCount }, (_, i) => `node-${i + 1}`);

  const nodes = nodeNames.map(name => {
    const notReady = rand() < nodeFailureRate;
    return {
      metadata: { name },
      spec: { unschedulable: false },
      status: {
        conditions: notReady
          ? [{ type: 'Ready', status: 'False', reason: 'KubeletNotPosting' }]
          : [{ type: 'Ready', status: 'True' }],
      },
    };
  });

  const pods = [];
  const events = [];
  const manifest = []; // { namespace, podName, mode } — what we intended to generate, for comparison against what the LLM actually classified

  for (const namespace of nsNames) {
    for (let i = 0; i < podsPerNamespace; i++) {
      const forceHealthy = rand() >= failureRate;
      const nodeName = nodeNames[Math.floor(rand() * nodeNames.length)];
      const { pod, event, mode, appName } = buildPod(rand, namespace, nodeName, forceHealthy ? 'healthy' : undefined);
      pods.push(pod);
      if (event) events.push(event);
      manifest.push({ namespace, podName: pod.metadata.name, appName, mode });
    }
  }

  return {
    seed,
    manifest,
    pods:   { items: pods },
    nodes:  { items: nodes },
    events: { items: events },
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const args = Object.fromEntries(process.argv.slice(2).map(a => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v];
  }));

  const fixture = generateFixture({
    namespaceCount:   args.namespaces   ? Number(args.namespaces)   : undefined,
    podsPerNamespace: args.perNamespace ? Number(args.perNamespace) : undefined,
    nodeCount:        args.nodes        ? Number(args.nodes)        : undefined,
    failureRate:      args.failureRate  ? Number(args.failureRate)  : undefined,
    nodeFailureRate:  args.nodeFailureRate ? Number(args.nodeFailureRate) : undefined,
    seed:             args.seed         ? Number(args.seed)         : undefined,
  });

  console.log(JSON.stringify(fixture, null, 2));
}

module.exports = { generateFixture, FAILURE_MODE_NAMES };
