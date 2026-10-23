'use strict';
const { Bus } = require('./bus');

// One shared Bus per process, connected lazily on first use — a process with every
// agent in local mode never opens a mesh connection at all.

let _bus = null;
let _connecting = null;

function _url() {
  return process.env.MESH_REDIS_URL || process.env.REDIS_URL || 'redis://localhost:6379';
}

async function getBus(serviceName = process.env.MESH_SERVICE_NAME || 'orchestrator') {
  if (_bus) return _bus;
  if (!_connecting) {
    const leaseMs = parseInt(process.env.MESH_LEASE_MS ?? '30000', 10);
    // Only the orchestrator and the k8s-write gateway are given this key (writeAuth.js),
    // so only their done-cache entries are sealed and verified.
    const integrityKey = process.env.MESH_WRITE_SIGNING_KEY || null;
    _connecting = new Bus({ url: _url(), serviceName, leaseMs, integrityKey }).connect()
      .then(b => { _bus = b; return b; })
      .catch(err => { _connecting = null; throw err; });
  }
  return _connecting;
}

async function closeBus(opts) {
  const b = _bus;
  _bus = null;
  _connecting = null;
  if (b) await b.close(opts);
}

module.exports = { getBus, closeBus };
