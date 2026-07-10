'use strict';

const { SilenceRule }           = require('../db/models');
const { createPubSub }          = require('./pubsub');
const { restoreActiveRecords }  = require('./restoreActiveRecords');

let seq = 0;
const silences = new Map(); // id → { id, key, until, reason, createdBy, createdAt }
const { notify, subscribe } = createPubSub();

// Auto-cleanup expired entries every minute
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of silences) {
    if (s.until <= now) {
      silences.delete(id);
      notify({ type: 'expired', id });
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
    await SilenceRule.deleteMany({ key });
    await SilenceRule.create({ key, until: new Date(until), reason: entry.reason, createdBy });
  } catch (err) {
    console.error('[SilenceStore] DB save failed:', err.message);
  }

  notify({ type: 'added', silence: entry });
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
    await SilenceRule.deleteMany({ key: entry.key });
  } catch (err) {
    console.error('[SilenceStore] DB delete failed:', err.message);
  }

  notify({ type: 'removed', id });
  return true;
}

function getAll() {
  const now = Date.now();
  return [...silences.values()].filter(s => s.until > now);
}

// ── Restore active silences from MongoDB on startup ───────────────────────────
async function init() {
  try {
    const restored = await restoreActiveRecords(
      SilenceRule,
      { until: { $gt: new Date() } },
      () => String(++seq),
      (doc, id) => ({
        id,
        key:       doc.key,
        until:     doc.until.getTime(),
        reason:    doc.reason ?? '',
        createdBy: doc.createdBy ?? {},
        createdAt: doc.createdAt?.toISOString() ?? new Date().toISOString(),
      })
    );
    for (const [id, entry] of restored) silences.set(id, entry);
    if (restored.length) console.log(`[SilenceStore] Restored ${restored.length} active silence(s)`);
  } catch (err) {
    console.error('[SilenceStore] Failed to restore silences:', err.message);
  }
}

module.exports = { init, add, remove, isSilenced, getAll, subscribe };
