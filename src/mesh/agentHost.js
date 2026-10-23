'use strict';
const express = require('express');
const { z } = require('zod');
const { getBus, closeBus } = require('./busSingleton');
const { runWithEffects } = require('./effects');
const { tracedHandler } = require('./tracing');

// ── Agent service host ─────────────────────────────────────────────────────
// Boots one agent as an independent service: serves each of its capabilities on the
// bus (src/mesh/bus.js) and exposes an HTTP side-channel with
//   GET /.well-known/agent.json — A2A-style Agent Card: name, version, capabilities and
//                                 their input/output JSON Schemas, dependencies
//   GET /healthz                — liveness/readiness for Kubernetes probes + live stats
// Every handler runs inside runWithEffects() so store writes made by the agent's code
// are shipped to the orchestrator instead of needing local DB connections.
//
// handlers: { [capability]: fn | { handler: fn, concurrency, description, input, output } }
//   fn(input, ctx) — ctx = { env, signal, hopMs } (see Bus.serve)
//   input/output   — optional zod schemas, published in the card

function _jsonSchema(schema) {
  if (!schema) return undefined;
  try { return z.toJSONSchema(schema, { unrepresentable: 'any' }); }
  catch { return { description: 'schema not representable as JSON Schema' }; }
}

// extendHttp(app) — optional: mount extra routes on the service's HTTP side-channel (e.g.
// k8s-read's MCP endpoint). Whatever it returns is published in the card as `interfaces`.
async function startAgent({ card, init = [], handlers, concurrency = 1, port, extendHttp }) {
  const serviceName = `${card.name}-svc`;
  process.env.MESH_SERVICE_NAME ??= serviceName;

  for (const fn of init) await fn();
  const bus = await getBus(serviceName);

  const stats = { startedAt: new Date().toISOString(), served: 0, failed: 0, inFlight: 0, lastHopMs: null, maxHopMs: 0 };
  const capabilities = [];

  for (const [capability, spec] of Object.entries(handlers)) {
    const { handler, concurrency: capConcurrency, description, input, output } =
      typeof spec === 'function' ? { handler: spec } : spec;

    await bus.serve(capability, async (taskInput, ctx) => {
      stats.inFlight++;
      stats.lastHopMs = ctx.hopMs;
      stats.maxHopMs  = Math.max(stats.maxHopMs, ctx.hopMs);
      const t0 = Date.now();
      console.log(`[${serviceName}] ▶ ${capability} task=${ctx.env.task.id} workflow=${ctx.env.task.workflowId ?? '-'} hop=${ctx.hopMs}ms`);
      try {
        const out = await runWithEffects(
          { bus, taskId: ctx.env.task.id, workflowId: ctx.env.task.workflowId },
          () => tracedHandler(ctx.env, serviceName, () => handler(taskInput, ctx)),
        );
        stats.served++;
        console.log(`[${serviceName}] ✔ ${capability} task=${ctx.env.task.id} in ${Date.now() - t0}ms`);
        return out;
      } catch (err) {
        stats.failed++;
        console.error(`[${serviceName}] ✖ ${capability} task=${ctx.env.task.id}: ${err.message}`);
        throw err;
      } finally {
        stats.inFlight--;
      }
    }, { concurrency: capConcurrency ?? concurrency });

    capabilities.push({
      id: capability,
      description,
      concurrency: capConcurrency ?? concurrency,
      inputSchema:  _jsonSchema(input),
      outputSchema: _jsonSchema(output),
    });
  }

  const agentCard = {
    protocol: 'kubepilot-mesh/1',
    ...card,
    instance: bus.sender,
    transport: { kind: 'redis-streams', taskStream: 'mesh:tasks:<capability>' },
    capabilities,
  };

  const app = express();
  const interfaces = extendHttp ? await extendHttp(app) : null;
  if (interfaces) agentCard.interfaces = interfaces;
  app.get('/.well-known/agent.json', (_req, res) => res.json(agentCard));
  app.get('/healthz', async (_req, res) => {
    try {
      await bus.cmd.ping();
      res.json({ status: 'ok', service: serviceName, instance: bus.sender, ...stats });
    } catch (err) {
      res.status(503).json({ status: 'redis-unreachable', error: err.message });
    }
  });

  const listenPort = port ?? parseInt(process.env.AGENT_PORT ?? '0', 10);
  const server = await new Promise(resolve => {
    const s = app.listen(listenPort, () => resolve(s));
  });
  console.log(`[${serviceName}] up — instance ${bus.sender}, capabilities: ${capabilities.map(c => c.id).join(', ')}, card at http://localhost:${server.address().port}/.well-known/agent.json`);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    console.log(`[${serviceName}] draining (${stats.inFlight} in flight)...`);
    server.close();
    await closeBus({ drain: true, drainTimeoutMs: 30_000 });
  };
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.once(sig, () => { stop().finally(() => process.exit(0)); });
  }

  return { bus, server, card: agentCard, stats, stop };
}

module.exports = { startAgent };
