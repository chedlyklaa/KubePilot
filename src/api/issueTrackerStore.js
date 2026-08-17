// Issue tracker store — persists the full detect → investigate → approve → fix →
// validate lifecycle of a remediation episode, so a user who clicks Approve (or just
// watches the agent work) can look up "what happened to that error" afterwards.
//
// Unlike approvalStore/escalationStore, this store has no in-memory "active" map —
// every call goes straight to MongoDB. It exists purely for observability (nothing
// reads it back to make a decision), so there's no correctness reason to keep a
// parallel in-memory copy, and going straight to Mongo means a server restart can't
// desync it from the database the way an unrestored in-memory map could.
//
// Writes are fire-and-forget from the caller's perspective (clusterAgent never awaits
// track()/resolve()) and never throw — a slow or unavailable DB must not block or
// break the remediation loop, exactly like audit/logger.js.

'use strict';

const { IssueTracker } = require('../db/models');
const { createPubSub } = require('./pubsub');

let seq = 0;
const { notify: _notify, subscribe } = createPubSub();

function _resourceOf(issue) {
  return issue?.controllerName ?? issue?.deployment ?? issue?.podName ?? issue?.nodeName ?? null;
}

// Maps a timeline stage/outcome pair to the record's top-level status.
function _statusFor(stage, outcome) {
  if (stage === 'detected')          return 'detected';
  if (stage === 'investigated')      return 'investigating';
  if (stage === 'awaiting_approval') return 'awaiting_approval';
  if (stage === 'approved')          return 'approved';
  if (stage === 'escalated')         return 'escalated';
  if (stage === 'progress')          return outcome ?? 'failed'; // blocked | skipped | failed | success
  return 'detected';
}

// Seed the display-id counter from whatever's already in Mongo so ids stay
// monotonic across restarts (same pattern as approvalStore/escalationStore's `seq`).
async function init() {
  try {
    const top = await IssueTracker.findOne().sort({ seq: -1 }).select('seq').lean();
    seq = top?.seq ?? 0;
    console.log(`[IssueTracker] Resuming from seq=${seq}`);
  } catch (err) {
    console.error('[IssueTracker] Failed to seed sequence:', err.message);
  }
}

// Records one lifecycle event for `issueKey`. `stage` drives both the timeline
// entry and the record's status — see _statusFor. Creates a new tracked episode on
// the first 'detected' call for a key (or if no still-open episode exists for it,
// e.g. after a server restart mid-episode), and appends to the existing open one
// otherwise — mirrors how clusterAgent's own episodeTimelines Map is keyed.
async function track(issueKey, ctx = {}) {
  const { stage, cluster, tier, issue, diagnosis, guardian, outcome, note, rca, fingerprint } = ctx;
  const status = _statusFor(stage, outcome);
  const entry  = {
    stage,
    action:          diagnosis?.action ?? null,
    outcome:         outcome ?? null,
    guardianVerdict: guardian?.verdict ?? null,
    note:            note ?? null,
    at:              new Date(),
  };

  try {
    // Look for the currently-open (non-fixed) episode for this key. Covers both
    // "first detection" (nothing open yet → create) and "server restarted mid-
    // episode, agent re-detects" (an open doc already exists → append instead of
    // creating a duplicate record).
    let doc = await IssueTracker.findOne({ issueKey, status: { $ne: 'fixed' } }).sort({ createdAt: -1 });

    if (!doc) {
      doc = new IssueTracker({
        seq: ++seq,
        issueKey,
        issueType:   issue?.type ?? null,
        cluster:     cluster ?? null,
        tier:        tier ?? null,
        namespace:   issue?.namespace ?? null,
        resource:    _resourceOf(issue),
        fingerprint: fingerprint ?? null,
        status,
        timeline:    [entry],
      });
    } else {
      doc.status = status;
      doc.timeline.push(entry);
      if (cluster)     doc.cluster     = cluster;
      if (tier)         doc.tier        = tier;
      if (fingerprint)  doc.fingerprint = fingerprint;
    }
    if (rca) doc.rca = rca;

    await doc.save();
    _notify({ type: doc.timeline.length === 1 ? 'added' : 'updated', issue: doc.toObject() });
    return doc.seq;
  } catch (err) {
    console.warn(`[IssueTracker] track() failed for "${issueKey}": ${err.message}`);
    return null;
  }
}

// Marks the currently-open episode for `issueKey` as terminally resolved.
async function resolve(issueKey, outcome = 'fixed', note = null) {
  try {
    const doc = await IssueTracker.findOne({ issueKey, status: { $ne: 'fixed' } }).sort({ createdAt: -1 });
    if (!doc) return;

    doc.status = outcome;
    doc.resolvedAt = new Date();
    doc.timeline.push({ stage: 'resolved', outcome, note: note ?? 'issue resolved', at: new Date() });
    await doc.save();
    _notify({ type: 'resolved', issue: doc.toObject() });
  } catch (err) {
    console.warn(`[IssueTracker] resolve() failed for "${issueKey}": ${err.message}`);
  }
}

async function list({ status = null, cluster = null, limit = 50, skip = 0 } = {}) {
  const filter = {};
  if (status)  filter.status  = status;
  if (cluster) filter.cluster = cluster;
  try {
    const [items, total] = await Promise.all([
      IssueTracker.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(limit).lean(),
      IssueTracker.countDocuments(filter),
    ]);
    return { items, total };
  } catch (err) {
    console.warn('[IssueTracker] list() failed:', err.message);
    return { items: [], total: 0 };
  }
}

async function getBySeq(seqId) {
  try {
    return await IssueTracker.findOne({ seq: Number(seqId) }).lean();
  } catch (err) {
    console.warn('[IssueTracker] getBySeq() failed:', err.message);
    return null;
  }
}

// Resolves an issueKey to its tracked display id (seq) — used to link an approval
// card back to its Issue Tracking page entry. Most-recent doc for the key, regardless
// of status: by the time an admin sees the approval, track() has already recorded at
// least a 'detected'/'awaiting_approval' entry for it (see clusterAgent.js), so this
// only returns null if that write genuinely never happened (DB hiccup) — callers use
// that to skip showing a link rather than linking to a page with nothing on it.
async function getSeqForIssueKey(issueKey) {
  try {
    const doc = await IssueTracker.findOne({ issueKey }).sort({ createdAt: -1 }).select('seq').lean();
    return doc?.seq ?? null;
  } catch (err) {
    console.warn('[IssueTracker] getSeqForIssueKey() failed:', err.message);
    return null;
  }
}

module.exports = { init, track, resolve, list, getBySeq, getSeqForIssueKey, subscribe };
