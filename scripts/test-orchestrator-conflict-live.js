#!/usr/bin/env node
// =============================================================================
// scripts/test-orchestrator-conflict-live.js — end-to-end, READ-ONLY observation
// of the REAL fleet-wide OrchestratorAgent against one or more live clusters:
// cross-cluster namespace correlation/classification, dispatch grouping/priority, and
// the Redis-backed conflict detector (per-dispatchKey resourceLock) that must prevent
// a second workflow from launching for a namespace (now correlated across clusters)
// that already has one in flight.
//
// This is a pure OBSERVATION harness — it does not modify src/. It:
//   1. Monkey-patches (wraps, doesn't edit on disk) the shared kubectl and shortMemory
//      singletons so every call they receive is logged with args/result before
//      delegating to the real implementation.
//   2. Monkey-patches clusterConfigStore.getClusters() to return ONLY the test
//      cluster(s) passed on the CLI — the fleet cycle now always reads clusters from
//      this store directly (there's no more per-cluster OrchestratorAgent instance to
//      construct), so this is what keeps the user's real clusters.yaml untouched.
//   3. Calls the real OrchestratorAgent._runFleetCycle() (exported test hook) for a
//      bounded number of ticks.
//   4. Writes every tool call, classification, dispatch-group, lock decision, and the
//      final short-memory state to ./test-output/orchestrator/.
//
// Actual cluster mutation is impossible regardless of this script: PolicyEngine.
// dryRunMode is hardcoded true (src/policy/policyEngine.js) — Executor simulates
// every write action and never calls kubectl for it (src/agents/executor.js).
//
// Usage:
//   node scripts/test-orchestrator-conflict-live.js --context=kind-kubepilot-test \
//     --cluster=kubepilot-test --namespaces=kp-test --ticks=6 --tickIntervalMs=15000
//   node scripts/test-orchestrator-conflict-live.js \
//     --clusters=kubepilot-test:kind-kubepilot-test,kubepilot-test-2:kind-kubepilot-test-2 \
//     --namespaces=kp-test --ticks=6 --tickIntervalMs=30000
// =============================================================================
'use strict';

require('dotenv').config({ override: true });
const fs        = require('fs');
const path      = require('path');
const mongoose  = require('mongoose');

const dbConnection = require('../src/db/connection');
const kubectl       = require('../src/tools/kubectl');
const shortMemory   = require('../src/memory/shortMemory');
const vectorStore    = require('../src/memory/vectorStore');
const episodicMemory = require('../src/memory/episodicMemory');
const issueTrackerStore = require('../src/api/issueTrackerStore');
const escalationStore   = require('../src/api/escalationStore');
const clusterConfigStore = require('../src/config/clusterConfig');

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? 'true'];
}));

const NAMESPACES     = args.namespaces ? args.namespaces.split(',') : ['*'];
const TICKS          = Number(args.ticks ?? 6);
const TICK_INTERVAL  = Number(args.tickIntervalMs ?? 15000);

// --clusters=name1:context1,name2:context2 (multi-cluster) takes priority; falls back
// to the original single-cluster --context[=X] --cluster[=Y] shape for backward compat.
const TEST_CLUSTERS = args.clusters
  ? args.clusters.split(',').map(pair => {
      const [name, context] = pair.split(':');
      return { name, context: context || name, tier: 'dev', namespaces: NAMESPACES };
    })
  : [{
      name: args.cluster || args.context || 'kubepilot-test',
      context: args.context || 'kind-kubepilot-test',
      tier: 'dev',
      namespaces: NAMESPACES,
    }];

const OUT_DIR = path.join(__dirname, '../test-output/orchestrator');
fs.mkdirSync(OUT_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

// ── Tool-call / decision log ────────────────────────────────────────────────
const toolCalls = [];   // every kubectl.* call, in order
const lockDecisions = []; // every shortMemory.acquireResourceLock call, in order
const groupEvents = [];   // addToGroup / clearGroup / enqueue / dequeue
const cycleLog = [];       // one entry per orchestrator tick, filled in from console interception

function logToolCall(fn, argsIn, resultOrErr, isError) {
  toolCalls.push({
    seq: toolCalls.length + 1,
    ts: new Date().toISOString(),
    fn,
    args: argsIn,
    ok: !isError,
    result: isError ? undefined : summarize(resultOrErr),
    error: isError ? String(resultOrErr?.message ?? resultOrErr) : undefined,
  });
}

function summarize(result) {
  const s = typeof result === 'string' ? result : JSON.stringify(result);
  if (s == null) return s;
  return s.length > 2000 ? s.slice(0, 2000) + `...[truncated ${s.length - 2000} chars]` : s;
}

// ── Wrap kubectl (shared singleton — orchestratorAgent.js requires the same
// module-cache instance, so patching methods here affects it too) ─────────────
for (const fnName of Object.keys(kubectl)) {
  const orig = kubectl[fnName];
  if (typeof orig !== 'function') continue;
  kubectl[fnName] = async function (...callArgs) {
    try {
      const result = await orig.apply(kubectl, callArgs);
      logToolCall(`kubectl.${fnName}`, callArgs, result, false);
      return result;
    } catch (err) {
      logToolCall(`kubectl.${fnName}`, callArgs, err, true);
      throw err;
    }
  };
}

// ── Redirect clusterConfigStore to the test cluster(s) only — never the user's real
// clusters.yaml. orchestratorAgent.js's fleet cycle calls getClusters() fresh every
// tick now (no more per-cluster instance to construct), so this is the whole scoping
// mechanism for this harness. ────────────────────────────────────────────────────
clusterConfigStore.getClusters = () => TEST_CLUSTERS;

// ── Wrap the shortMemory calls that matter for conflict detection — fleet-wide
// signatures now (no clusterName param on queue/active-set calls) ─────────────
const _acquireResourceLock = shortMemory.acquireResourceLock.bind(shortMemory);
shortMemory.acquireResourceLock = async function (key, workflowId, ttlMs) {
  const acquired = await _acquireResourceLock(key, workflowId, ttlMs);
  lockDecisions.push({
    seq: lockDecisions.length + 1,
    ts: new Date().toISOString(),
    dispatchKey: key,
    workflowId,
    acquired,
    interpretation: acquired
      ? 'lock acquired — new workflow launched for this dispatch key'
      : 'lock DENIED — another workflow already owns this dispatch key; conflict detector blocked a duplicate workflow',
  });
  return acquired;
};

const _addToGroup = shortMemory.addToGroup.bind(shortMemory);
shortMemory.addToGroup = async function (group, memberKey) {
  groupEvents.push({ ts: new Date().toISOString(), op: 'addToGroup', group, memberKey });
  return _addToGroup(group, memberKey);
};
const _clearGroup = shortMemory.clearGroup.bind(shortMemory);
shortMemory.clearGroup = async function (group) {
  groupEvents.push({ ts: new Date().toISOString(), op: 'clearGroup', group });
  return _clearGroup(group);
};
const _enqueue = shortMemory.enqueue.bind(shortMemory);
shortMemory.enqueue = async function (key, priority) {
  groupEvents.push({ ts: new Date().toISOString(), op: 'enqueue', key, priority });
  return _enqueue(key, priority);
};
const _dequeue = shortMemory.dequeue.bind(shortMemory);
shortMemory.dequeue = async function (maxCount) {
  const keys = await _dequeue(maxCount);
  groupEvents.push({ ts: new Date().toISOString(), op: 'dequeue', maxCount, dequeued: keys });
  return keys;
};

// Require OrchestratorAgent AFTER the monkey-patches above so its internal
// `require('../tools/kubectl')`/`require('../memory/shortMemory')`/
// `require('../config/clusterConfig')` resolve to the same (now-patched) module-cache
// singletons — Node caches modules by resolved path, so this ordering is what makes
// the patches visible to the agent's own calls.
const OrchestratorAgent = require('../src/agents/orchestratorAgent');

// ── Console capture — the codebase already logs extensively at each pipeline
// stage ([ORCHESTRATOR], [GRAPH] investigator/planner/guardian/policy/executor);
// mirror it to a raw log file instead of re-deriving that detail ─────────────────
const rawLogPath = path.join(OUT_DIR, `raw-stdout-${stamp}.log`);
const rawLogStream = fs.createWriteStream(rawLogPath, { flags: 'a' });
rawLogStream.on('error', () => {}); // defensive backstop — see streamEnded below
let streamEnded = false;
const origLog = console.log, origErr = console.error, origWarn = console.warn;
function tee(streamFn, prefix) {
  return (...a) => {
    // Fire-and-forget workflows (runWorkflow in orchestratorAgent.js) can still be
    // mid-flight after main() finishes and closes this stream — without this guard,
    // their console.log calls write-after-end and crash the whole process (confirmed
    // live, 2026-08-24: ERR_STREAM_WRITE_AFTER_END mid-investigation). Once closed,
    // still print to the real console (untouched below), just stop teeing to the file.
    if (!streamEnded) {
      rawLogStream.write(`[${new Date().toISOString()}]${prefix} ${a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')}\n`);
    }
    streamFn(...a);
  };
}
console.log = tee(origLog, '');
console.error = tee(origErr, ' [stderr]');
console.warn = tee(origWarn, ' [warn]');

async function main() {
  console.log(`\n=== test-orchestrator-conflict-live: starting (clusters=${TEST_CLUSTERS.map(c => `${c.name}:${c.context}`).join(',')} namespaces=${NAMESPACES.join(',')} ticks=${TICKS} interval=${TICK_INTERVAL}ms) ===\n`);

  await dbConnection.connect();
  await shortMemory.initialize();
  await vectorStore.initialize().catch(err => console.warn('[harness] vectorStore init failed (continuing):', err.message));
  await episodicMemory.initialize().catch(err => console.warn('[harness] episodicMemory init failed (continuing):', err.message));
  // Same boot sequence as index.js — without this, issueTrackerStore's in-memory `seq`
  // counter starts at 0 instead of resuming from Mongo's actual max, and every track()
  // call in this run collides with real pre-existing seq values (unique index) rather
  // than a genuine race in the store itself. Confirmed live, 2026-08-24: skipping this
  // produced a 100% track() failure rate for an otherwise-correct run.
  await escalationStore.init().catch(err => console.warn('[harness] escalationStore init failed (continuing):', err.message));
  await issueTrackerStore.init().catch(err => console.warn('[harness] issueTrackerStore init failed (continuing):', err.message));

  console.log(`[harness] shortMemory.ready = ${shortMemory.ready} (Redis) — conflict detection requires this to be true`);
  console.log(`[harness] clusterConfigStore.getClusters() -> ${clusterConfigStore.getClusters().map(c => c.name).join(', ')}`);

  for (let tick = 1; tick <= TICKS; tick++) {
    const before = { toolCalls: toolCalls.length, lockDecisions: lockDecisions.length, groupEvents: groupEvents.length };
    console.log(`\n----- TICK ${tick}/${TICKS} -----`);
    const t0 = Date.now();
    try {
      await OrchestratorAgent._runFleetCycle();
    } catch (err) {
      console.error(`[harness] tick ${tick} threw: ${err.message}`);
    }
    const durationMs = Date.now() - t0;
    cycleLog.push({
      tick,
      startedAt: new Date(t0).toISOString(),
      durationMs,
      newToolCalls: toolCalls.length - before.toolCalls,
      newLockDecisions: lockDecisions.slice(before.lockDecisions).map(l => ({ dispatchKey: l.dispatchKey, acquired: l.acquired })),
      newGroupEvents: groupEvents.length - before.groupEvents,
    });

    if (tick < TICKS) {
      console.log(`[harness] sleeping ${TICK_INTERVAL}ms before next tick...`);
      await new Promise(r => setTimeout(r, TICK_INTERVAL));
    }
  }

  // Let any still-running fire-and-forget workflows drain a bit before we snapshot
  // final short-memory state and exit, so the report reflects settled state where
  // possible (workflows can legitimately still be mid-flight — that's fine, we report it).
  console.log(`\n[harness] all ${TICKS} ticks issued — waiting 20s for in-flight workflows to progress before final snapshot...`);
  await new Promise(r => setTimeout(r, 20000));

  // ── Final short-memory snapshot ─────────────────────────────────────────────
  let finalShortMemory = { ready: shortMemory.ready };
  if (shortMemory.ready) {
    const client = shortMemory.client;
    const keys = await client.keys('sm:*');
    const entries = await Promise.all(keys.map(async k => {
      const type = await client.type(k);
      let value;
      if (type === 'string') value = await client.get(k);
      else if (type === 'set') value = await client.sMembers(k);
      else if (type === 'zset') value = await client.zRangeWithScores(k, 0, -1);
      else value = `(type ${type} not dumped)`;
      const ttl = await client.pTTL(k);
      return { key: k, type, value, pttlMs: ttl };
    }));
    finalShortMemory = { ready: true, keys: entries };
  }

  const report = {
    generatedAt: new Date().toISOString(),
    clusters: TEST_CLUSTERS,
    namespaces: NAMESPACES,
    ticks: TICKS,
    tickIntervalMs: TICK_INTERVAL,
    cycleLog,
    toolCalls,
    lockDecisions,
    groupEvents,
    finalShortMemory,
  };

  const outPath = path.join(OUT_DIR, `conflict-live-${stamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\n[harness] wrote report to ${outPath}`);
  console.log(`[harness] wrote raw stdout/stderr to ${rawLogPath}`);

  console.log(`\n=== SUMMARY ===`);
  console.log(`tool calls: ${toolCalls.length}`);
  console.log(`lock decisions: ${lockDecisions.length} (${lockDecisions.filter(l => l.acquired).length} acquired, ${lockDecisions.filter(l => !l.acquired).length} denied)`);
  for (const l of lockDecisions) {
    console.log(`  [${l.seq}] dispatchKey=${l.dispatchKey} acquired=${l.acquired} -> ${l.interpretation}`);
  }
}

main()
  .catch(err => {
    console.error('[test-orchestrator-conflict-live] FAILED:', err.stack || err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    streamEnded = true;
    rawLogStream.end();
    // Deliberately NOT quitting the shortMemory/mongoose connections here — a
    // fire-and-forget workflow can still be using them after main() returns, and
    // closing out from under it would throw. Node's event loop keeps the process
    // alive on its own (kubectl's execFile calls, the open Redis/Mongo sockets) until
    // any in-flight workflow actually finishes, so this just lets the process exit
    // naturally once nothing is left running instead of forcing a premature close.
  });
