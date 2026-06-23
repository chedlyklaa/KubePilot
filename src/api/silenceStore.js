'use strict';

let seq = 0;
const silences  = new Map(); // id → { id, key, until, reason, createdBy, createdAt }
const listeners = new Set();

function _notify(ev) { listeners.forEach(fn => fn(ev)); }

// Auto-cleanup expired entries every minute
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of silences) {
    if (s.until <= now) {
      silences.delete(id);
      _notify({ type: 'expired', id });
    }
  }
}, 60_000);

// ── Add or replace a silence for a key ────────────────────────────────────────
async function add(key, durationMs, reason, createdBy) {
  // Replace any existing silence for the same key so there's always at most one
  for (const [existingId, s] of silences) {
    if (s.key === key) { silences.delete(existingId); break; }
  }

  const id    = String(++seq);
  const until = Date.now() + durationMs;
  const entry = {
    id,
    key,
    until,
    reason:    reason ?? '',
    createdBy: createdBy ?? {},
    createdAt: new Date().toISOString(),
  };
  silences.set(id, entry);

  try {
    const { SilenceRule } = require('../db/models');
    await SilenceRule.deleteMany({ key });
    await SilenceRule.create({ key, until: new Date(until), reason: entry.reason, createdBy });
  } catch (err) {
    console.error('[SilenceStore] DB save failed:', err.message);
  }

  _notify({ type: 'added', silence: entry });
  console.log(`[SilenceStore] Silenced "${key}" for ${Math.round(durationMs / 60000)}m (until ${new Date(until).toISOString()})`);
  return entry;
}

// ── Check if a key is currently silenced ──────────────────────────────────────
function isSilenced(key) {
  const now = Date.now();
  for (const s of silences.values()) {
    if (s.key === key && s.until > now) return true;
  }
  return false;
}

// ── Lift a silence early by id ────────────────────────────────────────────────
async function remove(id) {
  const entry = silences.get(id);
  if (!entry) return false;
  silences.delete(id);

  try {
    const { SilenceRule } = require('../db/models');
    await SilenceRule.deleteMany({ key: entry.key });
  } catch (err) {
    console.error('[SilenceStore] DB delete failed:', err.message);
  }

  _notify({ type: 'removed', id });
  return true;
}

function getAll() {
  const now = Date.now();
  return [...silences.values()].filter(s => s.until > now);
}

function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

// ── Restore active silences from MongoDB on startup ───────────────────────────
async function init() {
  try {
    const { SilenceRule } = require('../db/models');
    const docs = await SilenceRule.find({ until: { $gt: new Date() } });
    for (const doc of docs) {
      const id = String(++seq);
      silences.set(id, {
        id,
        key:       doc.key,
        until:     doc.until.getTime(),
        reason:    doc.reason ?? '',
        createdBy: doc.createdBy ?? {},
        createdAt: doc.createdAt?.toISOString() ?? new Date().toISOString(),
      });
    }
    if (docs.length) console.log(`[SilenceStore] Restored ${docs.length} active silence(s)`);
  } catch (err) {
    console.error('[SilenceStore] Failed to restore silences:', err.message);
  }
}

module.exports = { init, add, remove, isSilenced, getAll, subscribe };
