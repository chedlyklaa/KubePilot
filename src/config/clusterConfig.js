'use strict';
const fs   = require('fs');
const path = require('path');
const yaml = require('js-yaml');

// Single cached source of clusters.yaml — shared by both the API layer (server.js routes)
// and the orchestrator, replacing what used to be ~8 separate `yaml.load(fs.readFileSync(...))`
// calls in server.js plus a second, independent fs.watch in src/orchestrator/index.js.
// Cache is refreshed on file change instead of on every read; on a transient parse error
// the last known-good value is kept rather than silently falling back to [].
//
// onChange() lets the orchestrator react to a reload (to reconcile live ClusterAgent
// instances) without maintaining its own separate watcher on the same file.
const CONFIG_PATH = path.join(__dirname, '../../config/clusters.yaml');

let _cache = null;
const _changeListeners = new Set();

function _load({ notify = false } = {}) {
  try {
    const parsed = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8'));
    _cache = parsed?.clusters ?? [];
  } catch (err) {
    console.error('[Config] Failed to load clusters.yaml:', err.message);
    _cache = _cache ?? [];
  }
  if (notify) _changeListeners.forEach(fn => fn(_cache));
  return _cache;
}

_load();
try {
  fs.watch(CONFIG_PATH, eventType => { if (eventType === 'change') _load({ notify: true }); });
} catch (err) {
  console.warn('[Config] Could not watch clusters.yaml for changes:', err.message);
}

function getClusters() {
  return _cache ?? _load();
}

// Subscribe to reloads triggered by a real file change (not the initial load).
// Returns an unsubscribe function.
function onChange(fn) {
  _changeListeners.add(fn);
  return () => _changeListeners.delete(fn);
}

module.exports = { CONFIG_PATH, getClusters, onChange };
