'use strict';
const express = require('express');
const { ApprovalHistory, EscalationHistory } = require('../../db/models');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');

const router = express.Router();

const DEFAULT_LIMIT = 20;
const MAX_LIMIT      = 100;

function parsePaging(query) {
  const page  = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(query.limit, 10) || DEFAULT_LIMIT));
  return { page, limit, skip: (page - 1) * limit };
}

function toArray(v) { return v == null ? [] : [].concat(v); }

// Matches a "who" field (e.g. decidedBy.email) against a list of emails, with a
// '__unassigned__' sentinel meaning "field missing/null" — mirrors the client-side
// filter semantics this replaces (`x.email ?? '__unassigned__'`). In Mongo,
// { field: null } already matches both missing and explicitly-null values.
function whoFilter(field, values) {
  if (!values.length) return null;
  const emails = values.filter(v => v !== '__unassigned__');
  const wantsUnassigned = values.includes('__unassigned__');
  const clauses = [];
  if (emails.length)     clauses.push({ [field]: { $in: emails } });
  if (wantsUnassigned)   clauses.push({ [field]: null });
  return clauses.length > 1 ? { $or: clauses } : clauses[0];
}

function dateRangeFilter(dateField, dateFrom, dateTo) {
  if (!dateFrom && !dateTo) return null;
  const range = {};
  if (dateFrom) range.$gte = new Date(`${dateFrom}T00:00:00.000Z`);
  if (dateTo)   range.$lte = new Date(`${dateTo}T23:59:59.999Z`);
  return { [dateField]: range };
}

router.get('/api/history/approvals', requireAuth, asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePaging(req.query);

  const clauses = [];
  const decisions = toArray(req.query.decision);
  const risks     = toArray(req.query.risk);
  if (decisions.length) clauses.push({ decision: { $in: decisions } });
  if (risks.length)     clauses.push({ 'diagnosis.risk': { $in: risks } });
  const who = whoFilter('decidedBy.email', toArray(req.query.userId));
  if (who) clauses.push(who);
  const range = dateRangeFilter('createdAt', req.query.dateFrom, req.query.dateTo);
  if (range) clauses.push(range);

  const filter = clauses.length ? { $and: clauses } : {};

  const [docs, total] = await Promise.all([
    ApprovalHistory.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    ApprovalHistory.countDocuments(filter),
  ]);
  res.json({ docs, total, page, pages: Math.max(1, Math.ceil(total / limit)) });
}));

router.get('/api/history/escalations', requireAuth, asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePaging(req.query);

  const clauses = [];
  const statuses = toArray(req.query.status);
  if (statuses.length) clauses.push({ status: { $in: statuses } });
  const who = whoFilter('assignedTo.email', toArray(req.query.userId));
  if (who) clauses.push(who);
  const range = dateRangeFilter('escalatedAt', req.query.dateFrom, req.query.dateTo);
  if (range) clauses.push(range);

  const filter = clauses.length ? { $and: clauses } : {};

  const [docs, total] = await Promise.all([
    EscalationHistory.find(filter).sort({ escalatedAt: -1 }).skip(skip).limit(limit),
    EscalationHistory.countDocuments(filter),
  ]);
  res.json({ docs, total, page, pages: Math.max(1, Math.ceil(total / limit)) });
}));

// Unfiltered totals for the tab badges — cheap, independent of the current page/filters.
router.get('/api/history/counts', requireAuth, asyncHandler(async (_req, res) => {
  const [approvals, escalations] = await Promise.all([
    ApprovalHistory.countDocuments(),
    EscalationHistory.countDocuments(),
  ]);
  res.json({ approvals, escalations });
}));

module.exports = router;
