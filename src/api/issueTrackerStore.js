'use strict';

const { IssueTracker } = require('../db/models');
const { createPubSub } = require('./pubsub');

let seq = 0;
const { notify: _notify, subscribe } = createPubSub();

function _resourceOf(issue) {
  return issue?.controllerName ?? issue?.deployment ?? issue?.podName ?? issue?.nodeName ?? null;
}

// Map a stage and outcome to a status
function _statusFor(stage, outcome) {
  if (stage === 'detected')          return 'detected';
  if (stage === 'investigated')      return 'investigating';
  if (stage === 'awaiting_approval') return 'awaiting_approval';
  if (stage === 'approved')          return 'approved';
  if (stage === 'escalated')         return 'escalated';
  if (stage === 'progress')          return outcome ?? 'failed';
  return 'detected';
}

// Load the id counter from MongoDB
async function init() {
  try {
    const top = await IssueTracker.findOne().sort({ seq: -1 }).select('seq').lean();
    seq = top?.seq ?? 0;
    console.log(`[IssueTracker] Resuming from seq=${seq}`);
  } catch (err) {
    console.error('[IssueTracker] Failed to seed sequence:', err.message);
  }
}

// Record a lifecycle event for an issue
async function track(issueKey, ctx = {}) {
  const { stage, cluster, tier, issue, diagnosis, guardian, outcome, note, rca, fingerprint, workflowId } = ctx;
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
        workflowId:  workflowId ?? null,
        status,
        timeline:    [entry],
      });
    } else {
      doc.status = status;
      doc.timeline.push(entry);
      if (cluster)     doc.cluster     = cluster;
      if (tier)         doc.tier        = tier;
      if (fingerprint)  doc.fingerprint = fingerprint;
      if (workflowId)   doc.workflowId  = workflowId;
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

// Mark an issue as resolved
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

// Get the display id for an issue key
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
