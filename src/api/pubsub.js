'use strict';

// Shared publish/subscribe helper for the in-memory stores (approvals, escalations,
// silences) — previously copy-pasted as `listeners = new Set()` + notify + subscribe
// independently in each store file.
function createPubSub() {
  const listeners = new Set();
  return {
    notify(event)  { listeners.forEach(fn => fn(event)); },
    subscribe(fn)  { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

module.exports = { createPubSub };
