#!/usr/bin/env node
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

const toolCalls = [];
const lockDecisions = [];
const groupEvents = [];
const cycleLog = [];

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

// Return only the test clusters
clusterConfigStore.getClusters = () => TEST_CLUSTERS;

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

const OrchestratorAgent = require('../src/agents/orchestratorAgent');

const rawLogPath = path.join(OUT_DIR, `raw-stdout-${stamp}.log`);
const rawLogStream = fs.createWriteStream(rawLogPath, { flags: 'a' });
rawLogStream.on('error', () => {});
let streamEnded = false;
const origLog = console.log, origErr = console.error, origWarn = console.warn;
function tee(streamFn, prefix) {
  return (...a) => {
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

  console.log(`\n[harness] all ${TICKS} ticks issued — waiting 20s for in-flight workflows to progress before final snapshot...`);
  await new Promise(r => setTimeout(r, 20000));

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
  });
