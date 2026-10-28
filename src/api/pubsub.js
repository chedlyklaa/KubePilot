'use strict';

// Create a simple publish/subscribe helper
function createPubSub() {
  const listeners = new Set();
  return {
    notify(event)  { listeners.forEach(fn => fn(event)); },
    subscribe(fn)  { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

module.exports = { createPubSub };
