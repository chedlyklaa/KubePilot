'use strict';
const fs   = require('fs');
const path = require('path');
const yaml = require('js-yaml');

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

// Subscribe to config reloads
function onChange(fn) {
  _changeListeners.add(fn);
  return () => _changeListeners.delete(fn);
}

module.exports = { CONFIG_PATH, getClusters, onChange };
