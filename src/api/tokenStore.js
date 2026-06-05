// Token usage counter — tracks LLM consumption per agent since last server start.
// Agents call record() after each LLM response; the dashboard reads getAll().

const AGENTS = ['planner', 'guardian', 'reflection'];

function _empty() { return { prompt: 0, completion: 0, total: 0, calls: 0 }; }

const counters = Object.fromEntries(AGENTS.map(k => [k, _empty()]));

function record(agent, usage) {
  if (!usage || !counters[agent]) return;
  const c = counters[agent];
  c.prompt     += usage.prompt_tokens     ?? 0;
  c.completion += usage.completion_tokens ?? 0;
  c.total      += usage.total_tokens      ?? 0;
  c.calls      += 1;
}

function getAll() {
  const total = Object.values(counters).reduce(
    (acc, c) => ({
      prompt:     acc.prompt     + c.prompt,
      completion: acc.completion + c.completion,
      total:      acc.total      + c.total,
      calls:      acc.calls      + c.calls,
    }),
    _empty(),
  );
  return { agents: { ...counters }, total };
}

function reset() {
  for (const k of AGENTS) counters[k] = _empty();
}

module.exports = { record, getAll, reset };
