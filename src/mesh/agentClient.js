'use strict';
const { getBus } = require('./busSingleton');
const { currentTask } = require('./effects');
const { tracedRequest } = require('./tracing');

// ── Local-or-remote agent client ──────────────────────────────────────────
// agentClient('investigator', ['investigate'], () => localAdapter) returns an object
// with the same methods in either mode, each taking ONE JSON-serializable input object:
//
//   AGENT_INVESTIGATOR_MODE=local  (default) → calls localAdapter.investigate(input) in-process
//   AGENT_INVESTIGATOR_MODE=remote           → bus.request('investigator.investigate', input)
//
// so a call site migrates by switching an env var, not by changing code. The local
// adapter is loaded lazily on first call, which keeps cross-agent requires (planner →
// investigator → reflection) free of load-order cycles and means remote mode never loads
// the agent's module (or its LLM client) into this process at all.

// Per-capability deadlines. Long enough for the slowest legitimate run (the
// investigator's 40-iteration loop), short enough that a wedged task is abandoned —
// crash recovery itself doesn't depend on these (that's the bus lease, ~2×MESH_LEASE_MS).
const DEFAULT_TIMEOUTS_MS = {
  fastpath:     2 * 60_000,
  investigator: 15 * 60_000,
  planner:      8 * 60_000,
  guardian:     3 * 60_000,
  reflection:   60_000,
  'k8s-read':   3 * 60_000, // verifyHealth polls for up to KUBECTL_WAIT_TIMEOUT (120s)
  'k8s-write':  2 * 60_000,
};

function modeEnvVar(name) {
  return `AGENT_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_MODE`;
}

function agentMode(name) {
  return process.env[modeEnvVar(name)] === 'remote' ? 'remote' : 'local';
}

function anyRemoteAgent() {
  return Object.keys(DEFAULT_TIMEOUTS_MS).some(name => agentMode(name) === 'remote');
}

function agentClient(name, methods, loadLocal) {
  const mode = agentMode(name);
  const client = { mode };

  if (mode === 'local') {
    let local = null;
    for (const m of methods) {
      // async so local mode always returns a Promise and throws asynchronously, exactly
      // like remote mode — call sites can't come to depend on a sync local behavior.
      client[m] = async (input, opts) => {
        local ??= loadLocal();
        return local[m](input, opts);
      };
    }
    return client;
  }

  for (const m of methods) {
    const capability = `${name}.${m}`;
    client[m] = async (input, opts = {}) => {
      const bus = await getBus();
      const workflowId = opts.workflowId ?? currentTask()?.workflowId ?? null;
      return tracedRequest(capability, { taskId: opts.taskId ?? null, workflowId }, traceHeaders =>
        bus.request(capability, input, {
          timeoutMs: DEFAULT_TIMEOUTS_MS[name] ?? 60_000,
          ...opts,
          workflowId,
          ...(traceHeaders ? { traceHeaders } : {}),
        }));
    };
  }
  return client;
}

module.exports = { agentClient, agentMode, anyRemoteAgent, modeEnvVar, DEFAULT_TIMEOUTS_MS };
