const { AsyncLocalStorage } = require('async_hooks');

const AGENTS = ['planner', 'guardian', 'reflection', 'investigator', 'fastPath', 'rootCauseFit', 'chat'];

function _empty() { return { prompt: 0, completion: 0, total: 0, cached: 0, calls: 0 }; }

const counters = Object.fromEntries(AGENTS.map(k => [k, _empty()]));
const scope    = new AsyncLocalStorage();

function _add(c, usage) {
  c.prompt     += usage.prompt_tokens     ?? 0;
  c.completion += usage.completion_tokens ?? 0;
  c.total      += usage.total_tokens      ?? 0;
  c.cached     += usage.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
  c.calls      += 1;
}

function record(agent, usage) {
  if (!usage || !counters[agent]) return;
  _add(counters[agent], usage);
  const scoped = scope.getStore();
  if (scoped) _add(scoped[agent] ??= _empty(), usage);
}

function _sum(byAgent) {
  return Object.values(byAgent).reduce((acc, c) => {
    for (const k of Object.keys(acc)) acc[k] += c[k] ?? 0;
    return acc;
  }, _empty());
}

function getAll() {
  return { agents: { ...counters }, total: _sum(counters) };
}

function reset() {
  for (const k of AGENTS) counters[k] = _empty();
}

// Run a function with its own token usage scope
async function withScope(fn) {
  const byAgent = {};
  const result = await scope.run(byAgent, fn);
  return { result, usage: { agents: byAgent, total: _sum(byAgent) } };
}

// Normalize token usage into one shape
function usageFrom(source) {
  const um = source?.usage_metadata;
  if (um) {
    return {
      prompt_tokens:     um.input_tokens  ?? 0,
      completion_tokens: um.output_tokens ?? 0,
      total_tokens:      um.total_tokens  ?? 0,
      cached_tokens:     um.input_token_details?.cache_read ?? 0,
    };
  }
  const tu = source?.response_metadata?.tokenUsage;
  if (tu) {
    return {
      prompt_tokens:     tu.promptTokens     ?? 0,
      completion_tokens: tu.completionTokens ?? 0,
      total_tokens:      tu.totalTokens      ?? 0,
      cached_tokens:     0,
    };
  }
  if (source && typeof source.prompt_tokens === 'number') {
    return { ...source, cached_tokens: source.prompt_tokens_details?.cached_tokens ?? source.cached_tokens ?? 0 };
  }
  return null;
}

// Record usage from a structured output result
function unwrapStructured(agent, output) {
  record(agent, usageFrom(output?.raw));
  if (output?.parsed == null) throw new Error('LLM structured output did not match the expected schema');
  return output.parsed;
}

module.exports = { record, getAll, reset, withScope, usageFrom, unwrapStructured, AGENTS };
