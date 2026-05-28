// Patches console.* and keeps a 1000-entry ring buffer.
// Must be required before any other module in index.js.

const MAX = 1000;
const logs = [];
let seq = 0;
const listeners = new Set();

function push(level, args) {
  const entry = {
    id: ++seq,
    timestamp: new Date().toISOString(),
    level,
    message: args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '),
  };
  logs.push(entry);
  if (logs.length > MAX) logs.shift();
  listeners.forEach(fn => fn(entry));
}

function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function getAll()      { return [...logs]; }

const _log   = console.log.bind(console);
const _warn  = console.warn.bind(console);
const _error = console.error.bind(console);

console.log   = (...a) => { _log(...a);   push('INFO',  a); };
console.warn  = (...a) => { _warn(...a);  push('WARN',  a); };
console.error = (...a) => { _error(...a); push('ERROR', a); };

module.exports = { getAll, subscribe };
