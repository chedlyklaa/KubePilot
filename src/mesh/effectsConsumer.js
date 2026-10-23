'use strict';
const { EFFECTS_STREAM } = require('./effects');

// Orchestrator-side applier for effects shipped by remote agent services (see
// src/mesh/effects.js). A consumer group with a STABLE consumer name means an
// orchestrator restart first finishes whatever it had read but not acked (id '0'),
// then continues with new entries ('>') — nothing emitted while it was down is lost.
// Assumes one orchestrator instance, which is how OrchestratorAgent is deployed today.

const GROUP    = 'orchestrator';
const CONSUMER = 'orchestrator';

function defaultAppliers() {
  return {
    tokens:   ({ agent, usage })  => require('../api/tokenStore').record(agent, usage),
    incident: ({ key, incident }) => require('../memory/shortMemory').upsertIncident(key, incident),
  };
}

async function startEffectsConsumer(bus, { appliers = defaultAppliers(), blockMs = 5_000 } = {}) {
  try {
    await bus.cmd.xGroupCreate(EFFECTS_STREAM, GROUP, '0', { MKSTREAM: true });
  } catch (err) {
    if (!/BUSYGROUP/.test(err.message)) throw err;
  }
  const reader = await bus._newReader();

  const loop = (async () => {
    let cursor = '0'; // own pending backlog first, then new entries
    while (!bus._closed) {
      let res;
      try {
        res = await reader.xReadGroup(GROUP, CONSUMER, { key: EFFECTS_STREAM, id: cursor }, {
          COUNT: 100, ...(cursor === '>' ? { BLOCK: blockMs } : {}),
        });
      } catch (err) {
        if (bus._closed) return;
        console.error(`[mesh] effects consumer: ${err.message}`);
        await new Promise(r => setTimeout(r, 1_000));
        continue;
      }
      const messages = res?.[0]?.messages ?? [];
      if (cursor === '0' && messages.length === 0) { cursor = '>'; continue; }

      for (const { id, message } of messages) {
        try {
          const effect = JSON.parse(message.e);
          const apply = appliers[effect.type];
          if (apply) await apply(effect.data, effect);
          else console.warn(`[mesh] effects consumer: no applier for "${effect.type}" (from ${effect.from})`);
        } catch (err) {
          // Effects are best-effort bookkeeping (counters, progress stages) — one bad entry
          // must not wedge the stream, so log and ack rather than retry forever.
          console.error(`[mesh] effects consumer: failed to apply ${id}: ${err.message}`);
        }
        await bus.cmd.xAck(EFFECTS_STREAM, GROUP, id);
      }
    }
  })();
  // Not returned: this is an async function, so returning the never-ending loop promise
  // would make `await startEffectsConsumer(...)` block forever. bus.close() awaits it.
  bus._loops.push(loop);
}

module.exports = { startEffectsConsumer };
