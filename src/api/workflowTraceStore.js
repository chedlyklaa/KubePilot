// Workflow trace store — persists one WorkflowTracer.toDocument() per runWorkflow()
// invocation for observability/comparison (current graph vs old workflow), never read
// back to make a remediation decision. Same conventions as issueTrackerStore.js: no
// in-memory "active" map (nothing needs it mid-run), writes are fire-and-forget from
// the caller's perspective and never throw — a slow/unavailable DB must not affect the
// remediation loop.

'use strict';

const { WorkflowTrace } = require('../db/models');

async function save(doc) {
  try {
    await WorkflowTrace.create(doc);
  } catch (err) {
    console.warn(`[WorkflowTraceStore] save() failed for workflow "${doc?.workflowId}": ${err.message}`);
  }
}

async function getByWorkflowId(workflowId) {
  try {
    return await WorkflowTrace.findOne({ workflowId }).lean();
  } catch (err) {
    console.warn(`[WorkflowTraceStore] getByWorkflowId() failed: ${err.message}`);
    return null;
  }
}

async function list({ pipeline = null, complexity = null, limit = 50, skip = 0 } = {}) {
  const filter = {};
  if (pipeline)   filter.pipeline   = pipeline;
  if (complexity) filter.complexity = complexity;
  try {
    const [items, total] = await Promise.all([
      WorkflowTrace.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      WorkflowTrace.countDocuments(filter),
    ]);
    return { items, total };
  } catch (err) {
    console.warn('[WorkflowTraceStore] list() failed:', err.message);
    return { items: [], total: 0 };
  }
}

module.exports = { save, getByWorkflowId, list };
