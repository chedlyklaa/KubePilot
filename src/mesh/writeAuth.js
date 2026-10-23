'use strict';
const crypto = require('crypto');
const { RefuseError } = require('./envelope');

// ── k8s-write authorization ────────────────────────────────────────────────
// Every agent service shares one Redis ACL user scoped to `mesh:*`, so any of them —
// including an LLM agent steered by a prompt injection — can XADD to
// mesh:tasks:k8s-write.apply. Reaching the stream must therefore not be enough to mutate
// a cluster: an apply is only executed when it carries an HMAC that the ORCHESTRATOR made
// in its executor node, i.e. after Guardian, PolicyEngine and (when required) human
// approval. The key (MESH_WRITE_SIGNING_KEY) is given only to the orchestrator and the
// k8s-write gateway — never to the LLM agents.
//
// The MAC binds the exact command, its target, the cluster context AND the task id: a
// captured authorization can't be reused for another command or cluster, and re-sending it
// under a different task id (to dodge the gateway's done-cache replay and apply again)
// fails too. Same task id → the done cache replays the stored result, nothing re-applies.
//
// The same key also signs the gateway's done-cache entries (src/mesh/bus.js
// integrityKey), so an agent can't forge "step N already applied" for a resumed executor.

const WRITE_AUTH_TTL_MS = 15 * 60_000;

function writeSigningKey() {
  return process.env.MESH_WRITE_SIGNING_KEY || null;
}

function _mac(key, { step, context }, taskId, exp) {
  const payload = JSON.stringify([
    taskId, context ?? null,
    step?.command ?? '', step?.target?.kind ?? null, step?.target?.name ?? null, step?.target?.namespace ?? null,
    exp,
  ]);
  return crypto.createHmac('sha256', key).update(payload).digest('hex');
}

// Orchestrator side.
function signWrite(input, taskId, now = Date.now()) {
  const key = writeSigningKey();
  if (!key) throw new Error('MESH_WRITE_SIGNING_KEY is not set — remote k8s-write requires it on the orchestrator and the k8s-write gateway');
  if (!taskId) throw new Error('a signed k8s-write apply needs a deterministic task id');
  const exp = now + WRITE_AUTH_TTL_MS;
  return { exp, mac: _mac(key, input, taskId, exp) };
}

// Gateway side. Fails closed: no key configured → every apply is refused.
function verifyWrite(input, taskId, now = Date.now()) {
  const key = writeSigningKey();
  if (!key) throw new RefuseError('k8s-write: MESH_WRITE_SIGNING_KEY is not configured — refusing all applies');
  const auth = input?.auth;
  if (!auth || typeof auth.mac !== 'string' || typeof auth.exp !== 'number') {
    throw new RefuseError('k8s-write: unsigned apply refused — only the orchestrator\'s executor may apply plan steps');
  }
  if (auth.exp < now) throw new RefuseError('k8s-write: apply authorization expired');
  const expected = Buffer.from(_mac(key, input, taskId, auth.exp), 'hex');
  const given    = Buffer.from(auth.mac, 'hex');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    throw new RefuseError('k8s-write: apply authorization does not match this step/context/task — refused');
  }
}

module.exports = { signWrite, verifyWrite, writeSigningKey, WRITE_AUTH_TTL_MS };
