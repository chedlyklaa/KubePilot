#!/usr/bin/env node
// =============================================================================
// scripts/prune-history.js — delete the N oldest Escalation / Approval records
//
// Deletes from the oldest record forward, up to the count you specify for each
// collection independently. Nothing is deleted unless you explicitly pass a count.
//
// Usage:
//   node scripts/prune-history.js --escalations=50 --approvals=20
//   node scripts/prune-history.js --escalations=10
//   node scripts/prune-history.js --escalations=50 --dry-run   (preview, deletes nothing)
// =============================================================================
'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const { connect } = require('../src/db/connection');
const { EscalationHistory, ApprovalHistory } = require('../src/db/models');

const ARGS = process.argv.slice(2).reduce((o, a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  o[k] = v ?? true;
  return o;
}, {});

const ESCALATIONS_COUNT = parseInt(ARGS.escalations ?? '0', 10);
const APPROVALS_COUNT   = parseInt(ARGS.approvals   ?? '0', 10);
const DRY_RUN            = !!ARGS['dry-run'];

async function pruneOldest(Model, label, count) {
  const totalBefore = await Model.countDocuments();

  if (!count || count <= 0) {
    console.log(`[prune] ${label}: skipped (no --${label.toLowerCase()}=N given) — total: ${totalBefore}`);
    return;
  }

  // Oldest-first, capped at `count` — naturally never deletes more than exists.
  const oldest = await Model.find().sort({ createdAt: 1 }).limit(count).select('_id createdAt issueKey');
  if (oldest.length === 0) {
    console.log(`[prune] ${label}: nothing to delete (collection is empty) — total: ${totalBefore}`);
    return;
  }

  console.log(`[prune] ${label}: ${oldest.length} oldest record(s) selected (requested ${count}) — total before: ${totalBefore}`);
  console.log(`         range: ${oldest[0].createdAt.toISOString()}  →  ${oldest[oldest.length - 1].createdAt.toISOString()}`);

  if (DRY_RUN) {
    console.log(`[prune] ${label}: DRY RUN — nothing deleted (would leave ${totalBefore - oldest.length} remaining)`);
    return;
  }

  const ids = oldest.map(d => d._id);
  const result = await Model.deleteMany({ _id: { $in: ids } });
  const totalAfter = await Model.countDocuments();
  console.log(`[prune] ${label}: deleted ${result.deletedCount} — total ${totalBefore} → ${totalAfter}`);
}

async function main() {
  if (!ESCALATIONS_COUNT && !APPROVALS_COUNT) {
    console.error('Nothing to do — pass --escalations=N and/or --approvals=N (add --dry-run to preview first).');
    console.error('Example: node scripts/prune-history.js --escalations=50 --approvals=20 --dry-run');
    process.exit(1);
  }

  await connect();
  if (DRY_RUN) console.log('[prune] DRY RUN — no documents will actually be deleted\n');

  await pruneOldest(EscalationHistory, 'Escalations', ESCALATIONS_COUNT);
  await pruneOldest(ApprovalHistory,   'Approvals',   APPROVALS_COUNT);

  await mongoose.disconnect();
  console.log('\n[prune] Done.');
}

main().catch(err => {
  console.error('[prune] Fatal:', err.message);
  process.exit(1);
});
