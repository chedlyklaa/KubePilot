'use strict';
const path = require('path');

// ── Durable workflow state (LangGraph checkpointer) ────────────────────────
// With the agents split into services (src/mesh/), the orchestrator process is the one
// remaining place a workflow's progress lives — so its restart used to throw away every
// in-flight workflow (resetActiveWorkflows at boot; the incident was only redispatched
// from scratch on a later detection cycle). LangGraph persists the full WorkflowState
// after every node into MongoDB, keyed by thread_id = workflowId, so a restarted
// orchestrator can continue an interrupted workflow from its last completed node instead.
//
// Collections: workflow_checkpoints / workflow_checkpoint_writes, in the app's own
// database (MONGODB_URI), with a TTL so abandoned threads expire on their own; finished
// workflows delete their thread explicitly (see graph.js runWorkflow).
//
// WORKFLOW_RESUME_ENABLED=false turns it all off (no checkpointer, no resume) — exactly
// the pre-existing behavior.

const CHECKPOINT_TTL_SEC = 7 * 24 * 60 * 60;

let _saver  = null;
let _client = null;

function resumeEnabled() {
  return process.env.WORKFLOW_RESUME_ENABLED !== 'false';
}

// The saver is built against its OWN mongodb driver (v6) — not mongoose's (v7) — so
// it's handed a client of exactly the type it was compiled against.
function _saverMongoClient() {
  const saverDir = path.dirname(require.resolve('@langchain/langgraph-checkpoint-mongodb'));
  return require(require.resolve('mongodb', { paths: [saverDir] })).MongoClient;
}

async function initCheckpointer({ uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/k8s_agent' } = {}) {
  if (!resumeEnabled()) return null;
  if (_saver) return _saver;
  try {
    const { MongoDBSaver } = require('@langchain/langgraph-checkpoint-mongodb');
    const MongoClient = _saverMongoClient();
    _client = new MongoClient(uri, { serverSelectionTimeoutMS: 5_000 });
    await _client.connect();
    const saver = new MongoDBSaver({
      client: _client,
      checkpointCollectionName:       'workflow_checkpoints',
      checkpointWritesCollectionName: 'workflow_checkpoint_writes',
      enableTimestamps: true,
      ttl: CHECKPOINT_TTL_SEC,
    });
    await saver.setup();
    _saver = saver;
    return _saver;
  } catch (err) {
    // Same degrade-don't-die convention as the other memory systems at boot: without a
    // checkpointer, workflows still run — they just can't be resumed after a restart.
    console.warn(`[Checkpoint] unavailable (${err.message}) — workflows will run without resume-after-restart`);
    await _client?.close().catch(() => {});
    _client = null;
    return null;
  }
}

function getCheckpointer() {
  return _saver;
}

async function closeCheckpointer() {
  const c = _client;
  _saver = null;
  _client = null;
  await c?.close().catch(() => {});
}

module.exports = { initCheckpointer, getCheckpointer, closeCheckpointer, resumeEnabled, CHECKPOINT_TTL_SEC };
