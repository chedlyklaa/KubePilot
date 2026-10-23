'use strict';

// ── LangSmith tracing across service boundaries ────────────────────────────
// In-process, every agent's LLM calls nest under the orchestrator's `fleet-cycle` trace
// automatically (AsyncLocalStorage). Once an agent runs as its own service that context
// stops at the process boundary — its calls would show up as separate, orphaned traces.
// LangSmith's distributed-tracing headers carry it across: the caller serializes its
// current run into the envelope's traceHeaders, and the service re-enters that run before
// calling the agent, so one incident is still one trace tree in LangSmith.
//
// Entirely inert unless tracing is enabled (LANGCHAIN_TRACING_V2 / LANGSMITH_TRACING=true).

function tracingEnabled() {
  return (process.env.LANGSMITH_TRACING ?? process.env.LANGCHAIN_TRACING_V2) === 'true';
}

// Caller side: runs `send(traceHeaders)` inside a child span "→ <capability>" of whatever
// run is current, and hands it that span's headers to put on the envelope.
async function tracedRequest(capability, summary, send) {
  if (!tracingEnabled()) return send(undefined);
  const { traceable } = require('langsmith/traceable');
  const { getCurrentRunTree } = require('langsmith/singletons/traceable');
  return traceable(
    async () => send(getCurrentRunTree(true)?.toHeaders()),
    { name: `→ ${capability}`, run_type: 'chain', metadata: { transport: 'kubepilot-mesh' } },
  )(summary);
}

// Service side: re-enters the caller's run (if the envelope carried one) and runs the
// handler as a child span "<service> <capability>", so the agent's own LLM/tool calls nest
// under it. Without headers (tracing off at the caller), runs the handler untraced-by-us.
async function tracedHandler(env, serviceName, handle) {
  if (!tracingEnabled() || !env?.traceHeaders) return handle();
  const { RunTree } = require('langsmith/run_trees');
  const { traceable } = require('langsmith/traceable');
  const { withRunTree } = require('langsmith/singletons/traceable');
  const parent = RunTree.fromHeaders(env.traceHeaders);
  if (!parent) return handle();
  return withRunTree(parent, () => traceable(
    async () => handle(),
    { name: `${serviceName} ${env.capability}`, run_type: 'chain', metadata: { instance: serviceName, taskId: env.task.id } },
  )({ taskId: env.task.id, workflowId: env.task.workflowId ?? null }));
}

module.exports = { tracingEnabled, tracedRequest, tracedHandler };
