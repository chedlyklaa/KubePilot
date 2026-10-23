'use strict';
const os = require('os');
const { randomUUID, createHmac, timingSafeEqual } = require('crypto');
const { createClient } = require('redis');
const { EnvelopeSchema } = require('./envelope');

// ── Agent Mesh bus (Redis Streams) ─────────────────────────────────────────
// Transport for the orchestrator-worker pattern: each capability ("investigator.
// investigate", "k8s-write.apply", ...) is a stream `mesh:tasks:<capability>` with one
// consumer group; every replica of the owning service is a consumer in that group, so
// load-balancing across replicas is free. Replies go to a per-instance stream
// `mesh:replies:<sender>` that only the requesting instance reads.
//
// Delivery is at-least-once. The handler-side guarantees that make that safe:
//   • done cache   — a finished task's reply is stored under its task id; a redelivered or
//                    re-sent task with the same id replays it instead of running again.
//   • running lock — a duplicate arriving while the task is still running registers as a
//                    waiter and gets the same reply, instead of starting a second run
//                    (matters for the investigator: a second run = a second LLM loop).
//   • lease        — while a handler runs, its message is re-claimed to itself every
//                    leaseMs/3, which resets the message's idle clock. The reclaim loop
//                    only takes messages idle ≥ 2×leaseMs, i.e. whose worker stopped
//                    renewing (crashed) — never a slow-but-alive one. So reclaim latency is
//                    ~2×leaseMs regardless of how long a capability legitimately runs.
//   • dead letter  — a message delivered maxDeliveries times without completing goes to
//                    `mesh:dlq:<capability>` and the caller gets a failure reply, instead of
//                    a poison task crashing replicas forever.

const GROUP = 'workers';
const taskStream  = cap => `mesh:tasks:${cap}`;
const dlqStream   = cap => `mesh:dlq:${cap}`;
const doneKey     = id  => `mesh:done:${id}`;
const runningKey  = id  => `mesh:running:${id}`;
const waitersKey  = id  => `mesh:waiters:${id}`;
const markerKey   = name => `mesh:marker:${name}`;

const TASK_STREAM_MAXLEN  = 10_000;
const REPLY_STREAM_MAXLEN = 1_000;
const REPLY_STREAM_TTL_MS = 60 * 60 * 1000;
const DONE_TTL_SEC        = 60 * 60; // inform results replay for an hour
// refuse/failure results are kept only briefly — long enough to answer waiters that
// registered just as the run finished, short enough that a caller's deliberate retry
// with the same task id actually re-runs.
const FAIL_TTL_SEC        = 5;
const REPLY_GRACE_MS      = 2_000;

class MeshError extends Error {
  constructor(performative, capability, message) {
    // refuse/failure carry the remote agent's own error text verbatim, so call sites that
    // surface err.message (executor outcomes, planner tool results the LLM reads) look the
    // same in remote mode as in local mode. Transport-level errors get the [mesh] prefix.
    super(performative === 'refuse' || performative === 'failure'
      ? message
      : `[mesh] ${capability} ${performative}: ${message}`);
    this.name = 'MeshError';
    this.performative = performative; // 'refuse' | 'failure' | 'timeout'
    this.capability   = capability;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

class Bus {
  constructor({
    url,
    serviceName,
    leaseMs = 30_000,
    maxDeliveries = 3,
    blockMs = 5_000,
    logger = console,
    // When set, this instance HMACs the done-cache entries it writes and ignores any it
    // can't verify. Every service shares one Redis ACL user, so without it any agent could
    // SET mesh:done:<id> and have a forged result replayed (see src/mesh/writeAuth.js).
    integrityKey = null,
  }) {
    this.url           = url;
    // Random suffix even when HOSTNAME is set: docker-compose reuses container hostnames
    // across restarts, and a reused reply-stream name would replay the old instance's
    // replies into a fresh pending map.
    this.sender        = `${serviceName}#${process.env.HOSTNAME ?? os.hostname()}-${randomUUID().slice(0, 6)}`;
    this.replyStream   = `mesh:replies:${this.sender}`;
    this.leaseMs       = leaseMs;
    this.maxDeliveries = maxDeliveries;
    this.blockMs       = blockMs;
    this.log           = logger;
    this.integrityKey  = integrityKey;

    this.cmd      = null;
    this._readers = [];
    this._timers  = [];
    this._pending = new Map(); // request envelope id -> { resolve, reject, timer, capability }
    this._active  = new Set(); // stream message ids currently being handled by this instance
    this._loops   = [];
    this._serving = []; // per-capability slot state, so close() can wake parked loops
    this._closed  = false;
    this._draining = false;
    this._replyLoop = null;
  }

  async connect() {
    this.cmd = createClient({ url: this.url });
    this.cmd.on('error', err => { if (!this._closed) this.log.error(`[mesh] redis error: ${err.message}`); });
    await this.cmd.connect();
    return this;
  }

  // Blocking reads (XREAD/XREADGROUP BLOCK) hold their connection for the whole block,
  // so each reading loop gets its own; commands always go through this.cmd.
  async _newReader() {
    const reader = this.cmd.duplicate();
    reader.on('error', err => { if (!this._closed) this.log.error(`[mesh] redis reader error: ${err.message}`); });
    await reader.connect();
    this._readers.push(reader);
    return reader;
  }

  // ── Client side ───────────────────────────────────────────────────────────

  async request(capability, input, { taskId, workflowId = null, timeoutMs = 60_000, traceHeaders } = {}) {
    if (this._closed) throw new MeshError('failure', capability, 'bus is closed');
    await this._ensureReplyLoop();

    const now = Date.now();
    const env = {
      id: randomUUID(),
      performative: 'request',
      capability,
      task: { id: taskId ?? randomUUID(), workflowId, input },
      sender: this.sender,
      replyTo: this.replyStream,
      deadline: now + timeoutMs,
      sentAt: now,
      ...(traceHeaders ? { traceHeaders } : {}),
    };

    // Client waits slightly past the deadline so the handler's own deadline abort (and
    // its clean failure reply) normally wins over a bare client-side timeout.
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(env.id);
        reject(new MeshError('timeout', capability, `no reply within ${timeoutMs}ms`));
      }, timeoutMs + REPLY_GRACE_MS);
      this._pending.set(env.id, { resolve, reject, timer, capability });
    });

    try {
      await this.cmd.xAdd(taskStream(capability), '*', { env: JSON.stringify(env) }, {
        TRIM: { strategy: 'MAXLEN', strategyModifier: '~', threshold: TASK_STREAM_MAXLEN },
      });
    } catch (err) {
      const p = this._pending.get(env.id);
      if (p) { clearTimeout(p.timer); this._pending.delete(env.id); }
      throw new MeshError('failure', capability, `could not enqueue: ${err.message}`);
    }
    return result;
  }

  async _ensureReplyLoop() {
    if (!this._replyLoop) {
      this._replyLoop = this._newReader().then(reader => {
        const loop = this._consumeReplies(reader);
        this._loops.push(loop);
      });
    }
    return this._replyLoop;
  }

  async _consumeReplies(reader) {
    // '0-0', not '$': the reply stream is unique to this instance (random sender suffix),
    // so reading from the start can't replay anyone else's replies — and '$' would race a
    // reply that lands before this loop's first XREAD is issued.
    let lastId = '0-0';
    while (!this._closed) {
      let res;
      try {
        res = await reader.xRead({ key: this.replyStream, id: lastId }, { BLOCK: this.blockMs, COUNT: 100 });
      } catch (err) {
        if (this._closed) return;
        this.log.error(`[mesh] reply loop: ${err.message}`);
        await sleep(1_000);
        continue;
      }
      for (const { messages } of res ?? []) {
        for (const { id, message } of messages) {
          lastId = id;
          let env;
          try { env = JSON.parse(message.env); } catch { continue; }
          const p = this._pending.get(env.inReplyTo);
          if (!p) continue; // late reply after a client-side timeout, or a waiter double-reply
          clearTimeout(p.timer);
          this._pending.delete(env.inReplyTo);
          if (env.performative === 'inform') p.resolve(env.task.output);
          else p.reject(new MeshError(env.performative, env.capability, env.task.error ?? 'unknown error'));
        }
      }
    }
  }

  // ── Markers ───────────────────────────────────────────────────────────────
  // Durable caller-side facts that must survive a caller restart, with the same lifetime
  // as the done cache — e.g. "this plan was aborted and rolled back" (graph.js), which no
  // single task's cached reply can express.

  async setMarker(name, ttlSec = DONE_TTL_SEC) {
    await this.cmd.set(markerKey(name), '1', { EX: ttlSec });
  }

  async hasMarker(name) {
    return (await this.cmd.exists(markerKey(name))) === 1;
  }

  // ── Server side ───────────────────────────────────────────────────────────

  // handler(input, ctx) → output. ctx = { env, signal, hopMs }. Throw a RefuseError
  // (src/mesh/envelope.js) to reply `refuse`; any other throw replies `failure`.
  async serve(capability, handler, { concurrency = 1 } = {}) {
    const stream = taskStream(capability);
    try {
      // '0': tasks enqueued before this capability's first-ever worker started still get processed.
      await this.cmd.xGroupCreate(stream, GROUP, '0', { MKSTREAM: true });
    } catch (err) {
      if (!/BUSYGROUP/.test(err.message)) throw err;
    }

    const slots = { inFlight: 0, wake: null };
    this._serving.push(slots);
    const ctx   = { capability, stream, handler, slots, concurrency };
    const reader = await this._newReader();

    const reclaimTimer = setInterval(() => {
      this._reclaim(ctx).catch(err => { if (!this._closed) this.log.error(`[mesh] reclaim ${capability}: ${err.message}`); });
    }, this.leaseMs);
    this._timers.push(reclaimTimer);

    this._loops.push(this._consumeTasks(reader, ctx));
  }

  async _consumeTasks(reader, ctx) {
    const { stream, slots, concurrency, capability } = ctx;
    while (!this._closed && !this._draining) {
      const free = concurrency - slots.inFlight;
      if (free <= 0) {
        await new Promise(resolve => { slots.wake = resolve; });
        continue;
      }
      let res;
      try {
        res = await reader.xReadGroup(GROUP, this.sender, { key: stream, id: '>' }, { COUNT: free, BLOCK: this.blockMs });
      } catch (err) {
        if (this._closed) return;
        this.log.error(`[mesh] task loop ${capability}: ${err.message}`);
        await sleep(1_000);
        continue;
      }
      for (const { messages } of res ?? []) {
        for (const { id, message } of messages) this._dispatch(ctx, id, message);
      }
    }
  }

  _dispatch(ctx, id, message) {
    const { slots } = ctx;
    slots.inFlight++;
    this._active.add(id);
    this._handle(ctx, id, message)
      .catch(err => { if (!this._closed) this.log.error(`[mesh] ${ctx.capability} handler: ${err.message}`); })
      .finally(() => {
        this._active.delete(id);
        slots.inFlight--;
        const wake = slots.wake;
        slots.wake = null;
        wake?.();
      });
  }

  async _reply(target, env, performative, fields) {
    const reply = {
      ...env,
      id: randomUUID(),
      performative,
      inReplyTo: target.id,
      sender: this.sender,
      replyTo: undefined,
      sentAt: Date.now(),
      task: { id: env.task.id, workflowId: env.task.workflowId ?? null, ...fields },
    };
    await this.cmd.xAdd(target.replyTo, '*', { env: JSON.stringify(reply) }, {
      TRIM: { strategy: 'MAXLEN', strategyModifier: '~', threshold: REPLY_STREAM_MAXLEN },
    });
    await this.cmd.pExpire(target.replyTo, REPLY_STREAM_TTL_MS);
  }

  // The MAC covers the task id too, so a genuine entry copied under another task's key
  // doesn't verify either.
  _doneMac(taskId, performative, fields) {
    return createHmac('sha256', this.integrityKey).update(JSON.stringify([taskId, performative, fields])).digest('hex');
  }

  _sealDone(taskId, performative, fields) {
    const entry = { performative, fields };
    if (this.integrityKey) entry.mac = this._doneMac(taskId, performative, fields);
    return JSON.stringify(entry);
  }

  // → { performative, fields }, or null when absent or (with an integrityKey) not verifiable.
  _openDone(taskId, raw, capability) {
    if (!raw) return null;
    let entry;
    try { entry = JSON.parse(raw); } catch { return null; }
    if (this.integrityKey) {
      const expected = Buffer.from(this._doneMac(taskId, entry.performative, entry.fields), 'hex');
      const given    = Buffer.from(typeof entry.mac === 'string' ? entry.mac : '', 'hex');
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
        this.log.warn(`[mesh] ${capability}: ignoring unverifiable done-cache entry for task ${taskId} (forged or written without the integrity key)`);
        return null;
      }
    }
    return { performative: entry.performative, fields: entry.fields };
  }

  async _handle(ctx, id, message) {
    const { stream, handler, capability } = ctx;
    const receivedAt = Date.now();

    let env;
    try {
      env = EnvelopeSchema.parse(JSON.parse(message.env));
    } catch (err) {
      // No trustworthy replyTo to answer — park it for inspection and move on.
      this.log.error(`[mesh] ${capability}: malformed envelope ${id}: ${err.message}`);
      await this.cmd.xAdd(dlqStream(capability), '*', { ...message, reason: `malformed: ${err.message}` });
      await this.cmd.xAck(stream, GROUP, id);
      return;
    }
    const taskId = env.task.id;
    const self   = { id: env.id, replyTo: env.replyTo };

    // 1. Already done → replay.
    const cached = this._openDone(taskId, await this.cmd.get(doneKey(taskId)), capability);
    if (cached) {
      const { performative, fields } = cached;
      await this._reply(self, env, performative, fields);
      await this.cmd.xAck(stream, GROUP, id);
      return;
    }

    // 2. Too late to be useful → refuse without running.
    if (Date.now() > env.deadline) {
      await this._reply(self, env, 'refuse', { error: 'deadline exceeded before the task started' });
      await this.cmd.xAck(stream, GROUP, id);
      return;
    }

    // 3. Someone (another replica, or a previous delivery) is already running it → wait for theirs.
    const gotLock = await this.cmd.set(runningKey(taskId), this.sender, { NX: true, PX: this.leaseMs });
    if (!gotLock) {
      await this.cmd.rPush(waitersKey(taskId), JSON.stringify(self));
      await this.cmd.pExpire(waitersKey(taskId), this.leaseMs * 4);
      // The runner reads waiters only AFTER writing the done cache, so re-checking the
      // cache here closes the race where it finished between our SET NX and RPUSH.
      const late = this._openDone(taskId, await this.cmd.get(doneKey(taskId)), capability);
      if (late) {
        const { performative, fields } = late;
        await this._reply(self, env, performative, fields);
      }
      await this.cmd.xAck(stream, GROUP, id);
      return;
    }

    // 4. Run it, holding the lease.
    const renew = setInterval(() => {
      Promise.all([
        this.cmd.xClaimJustId(stream, GROUP, this.sender, 0, id),
        this.cmd.pExpire(runningKey(taskId), this.leaseMs),
        this.cmd.pExpire(waitersKey(taskId), this.leaseMs * 4),
      ]).catch(() => {});
    }, Math.max(50, Math.floor(this.leaseMs / 3)));

    const abort = new AbortController();
    const deadlineTimer = setTimeout(
      () => abort.abort(new Error('task deadline exceeded')),
      Math.max(0, env.deadline - Date.now()),
    );

    let performative, fields;
    try {
      const output = await handler(env.task.input, {
        env, signal: abort.signal, hopMs: receivedAt - env.sentAt,
      });
      performative = 'inform';
      fields = { output: output ?? null };
    } catch (err) {
      performative = err?.refuse ? 'refuse' : 'failure';
      fields = { error: err?.message ?? String(err) };
    } finally {
      clearInterval(renew);
      clearTimeout(deadlineTimer);
    }

    if (this._closed) return; // crashed/closed mid-run: leave it pending for reclaim

    // An inform produced AFTER the deadline abort is the handler's best-effort salvage
    // (e.g. the investigator's partial/fallback report), not its real answer: still reply
    // with it, but cache it only as briefly as a failure, so a later re-send of the same
    // task id re-runs instead of replaying the truncated result for an hour.
    const complete = performative === 'inform' && !abort.signal.aborted;
    await this.cmd.set(doneKey(taskId), this._sealDone(taskId, performative, fields), {
      EX: complete ? DONE_TTL_SEC : FAIL_TTL_SEC,
    });
    const waiters = (await this.cmd.lRange(waitersKey(taskId), 0, -1)).map(w => JSON.parse(w));
    await Promise.all([self, ...waiters].map(t => this._reply(t, env, performative, fields).catch(err =>
      this.log.error(`[mesh] ${capability}: reply to ${t.replyTo} failed: ${err.message}`))));
    await this.cmd.del([runningKey(taskId), waitersKey(taskId)]);
    await this.cmd.xAck(stream, GROUP, id);
  }

  async _reclaim(ctx) {
    if (this._closed || this._draining) return;
    const { stream, capability, slots, concurrency } = ctx;
    const minIdle = this.leaseMs * 2;
    const pending = await this.cmd.xPendingRange(stream, GROUP, '-', '+', 20, { IDLE: minIdle });

    for (const p of pending) {
      if (this._closed) return;
      if (this._active.has(p.id)) continue;

      if (p.deliveriesCounter >= this.maxDeliveries) {
        const [msg] = await this.cmd.xRange(stream, p.id, p.id);
        if (msg) {
          await this.cmd.xAdd(dlqStream(capability), '*', { ...msg.message, reason: `exceeded ${this.maxDeliveries} deliveries` });
          try {
            const env = JSON.parse(msg.message.env);
            if (env.replyTo) {
              await this._reply({ id: env.id, replyTo: env.replyTo }, env, 'failure',
                { error: `task crashed its worker ${p.deliveriesCounter} times — moved to ${dlqStream(capability)}` });
            }
          } catch { /* malformed — nothing to answer */ }
        }
        await this.cmd.xAck(stream, GROUP, p.id);
        this.log.warn(`[mesh] ${capability}: ${p.id} dead-lettered after ${p.deliveriesCounter} deliveries`);
        continue;
      }

      if (slots.inFlight >= concurrency) return;
      // Passing minIdle again makes the claim atomic against other reclaimers: if one of
      // them (or a recovering owner's lease) touched it since XPENDING, this returns nothing.
      const claimed = await this.cmd.xClaim(stream, GROUP, this.sender, minIdle, p.id);
      for (const m of claimed) {
        if (!m) { await this.cmd.xAck(stream, GROUP, p.id); continue; } // trimmed away
        this.log.warn(`[mesh] ${capability}: reclaimed ${m.id} from ${p.consumer} (delivery ${p.deliveriesCounter + 1})`);
        this._dispatch(ctx, m.id, m.message);
      }
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  _wakeAll() {
    for (const slots of this._serving) {
      const wake = slots.wake;
      slots.wake = null;
      wake?.();
    }
  }

  // Stop taking new tasks and wait (bounded) for in-flight ones to finish replying.
  async drain(timeoutMs = 30_000) {
    this._draining = true;
    this._wakeAll();
    const until = Date.now() + timeoutMs;
    while (this._active.size > 0 && Date.now() < until) await sleep(100);
  }

  // drain:false simulates a crash (used by tests): in-flight tasks are left pending in
  // the stream, unacked, for another replica's reclaim loop to pick up.
  async close({ drain = true, drainTimeoutMs = 30_000 } = {}) {
    if (drain) await this.drain(drainTimeoutMs);
    this._closed = true;
    this._wakeAll();
    for (const t of this._timers) clearInterval(t);
    for (const [, p] of this._pending) {
      clearTimeout(p.timer);
      p.reject(new MeshError('failure', p.capability, 'bus closed'));
    }
    this._pending.clear();
    for (const r of this._readers) { try { r.destroy(); } catch { /* already gone */ } }
    await Promise.allSettled(this._loops);
    try { this.cmd.destroy(); } catch { /* already gone */ }
  }
}

module.exports = { Bus, MeshError, GROUP, taskStream, dlqStream, doneKey };
