'use strict';
const store = new Map();

const set   = (issueKey, data) => store.set(issueKey, data);
const get   = (issueKey) => store.get(issueKey) ?? null;
const clear = (issueKey) => store.delete(issueKey);

// The key approvalStore.js writes an admin's override feedback under, derived from the issue.
const keyFor = (issue) => `${issue.type}:${issue.deployment ?? issue.podName}:${issue.namespace ?? 'default'}`;

// Read-and-clear in one step. This store lives in the API/orchestrator process (it's
// in-memory), so the orchestrator takes the override and hands it to
// ReflectionAgent.reflect() as input — which works whether Reflection runs in-process or
// as its own service, where this Map would always be empty.
const takeFor = (issue) => {
  const key  = keyFor(issue);
  const data = get(key);
  if (data) clear(key);
  return data;
};

// Two-phase alternative to takeFor for callers whose use of the override can fail
// (graph.js: remote reflection may time out): peek first, consume only once it has
// actually been stored — and only if it is still the same entry, so feedback an admin
// submitted in the meantime isn't wiped with it.
const peekFor = (issue) => get(keyFor(issue));
const consumeFor = (issue, data) => {
  const key = keyFor(issue);
  if (data && store.get(key) === data) clear(key);
};

module.exports = { set, get, clear, keyFor, takeFor, peekFor, consumeFor };
