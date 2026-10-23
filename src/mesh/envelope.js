'use strict';
const { z } = require('zod');

// ── Agent Mesh envelope ────────────────────────────────────────────────────
// One message shape for every agent-to-agent exchange on the bus (src/mesh/bus.js).
// Combines an ACL-style performative (FIPA "request"/"inform"/"refuse"/"failure" —
// the purpose of the message, not just its payload) with an A2A-style Task object
// (a discrete, identified unit of work).
//
//   request  — orchestrator/agent → agent: "do this capability with this input"
//   inform   — the task completed; task.output carries the result
//   refuse   — the agent declined without attempting it (bad input, deadline already
//              passed, gateway refused the cluster) — never retried by the bus
//   failure  — the agent tried and crashed; task.error carries the reason
//
// A domain-level "no" (e.g. Guardian REJECT) is NOT a refuse — it's a normal verdict
// carried in an inform. The performative describes the protocol outcome only.

const Performative = z.enum(['request', 'inform', 'refuse', 'failure']);

const TaskSchema = z.object({
  // Idempotency key. Deterministic for anything with side effects
  // (e.g. `${workflowId}:apply:${issueKey}:${attempt}:${stepIndex}`) so a redelivered or
  // re-sent task replays its stored result instead of running twice.
  id:         z.string().min(1),
  workflowId: z.string().nullable().optional(),
  input:      z.unknown().optional(),
  output:     z.unknown().optional(),
  error:      z.string().optional(),
});

const EnvelopeSchema = z.object({
  id:           z.string().min(1),
  performative: Performative,
  capability:   z.string().min(1),      // "<agent>.<method>", e.g. "investigator.investigate"
  task:         TaskSchema,
  sender:       z.string().min(1),      // "<service>#<instance>"
  replyTo:      z.string().optional(),  // reply stream key (request only)
  inReplyTo:    z.string().optional(),  // request envelope id (replies only)
  deadline:     z.number(),             // epoch ms — work past this is abandoned
  sentAt:       z.number(),             // epoch ms — for hop-latency measurement
  traceHeaders: z.record(z.string(), z.string()).optional(),
});

class RefuseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RefuseError';
    this.refuse = true;
  }
}

module.exports = { EnvelopeSchema, TaskSchema, Performative, RefuseError };
