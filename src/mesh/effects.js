'use strict';
const { AsyncLocalStorage } = require('async_hooks');

// ── Side effects across the service boundary ──────────────────────────────
// Some agent code writes to stores owned by the orchestrator process:
// tokenStore.record() (in-memory counters the dashboard reads — in a separate process
// they'd just be lost) and shortMemory.upsertIncident() (Redis sm:* keys). Rather than
// give every agent service those connections/credentials, a write made INSIDE a mesh
// handler is shipped to the `mesh:effects` stream and applied by the orchestrator's
// effectsConsumer.js. The store call sites stay unchanged: each store checks
// `effects.emit(...)` first and skips its own write when it returns true.
//
// Outside a mesh handler (local mode, the orchestrator itself, tests) there is no
// AsyncLocalStorage context, emit() returns false, and the store behaves exactly as before.

const EFFECTS_STREAM = 'mesh:effects';
const EFFECTS_MAXLEN = 50_000;

const als = new AsyncLocalStorage();

// ctx = { bus, taskId, workflowId }
function runWithEffects(ctx, fn) {
  return als.run(ctx, fn);
}

function emit(type, data) {
  const ctx = als.getStore();
  if (!ctx) return false;
  ctx.bus.cmd.xAdd(EFFECTS_STREAM, '*', {
    e: JSON.stringify({
      type, data,
      taskId: ctx.taskId, workflowId: ctx.workflowId ?? null,
      from: ctx.bus.sender, at: Date.now(),
    }),
  }, {
    TRIM: { strategy: 'MAXLEN', strategyModifier: '~', threshold: EFFECTS_MAXLEN },
  }).catch(err => console.error(`[mesh] effect "${type}" not shipped: ${err.message}`));
  return true;
}

// The mesh task this code is running inside, if any — lets a nested agent-to-agent call
// (e.g. investigator-svc → k8s-read) inherit the enclosing workflowId.
function currentTask() {
  return als.getStore() ?? null;
}

module.exports = { runWithEffects, emit, currentTask, EFFECTS_STREAM };
