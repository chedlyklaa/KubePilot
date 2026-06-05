'use strict';
const { randomUUID }   = require('crypto');
const { IncidentEpisode } = require('../db/models');
const vectorStore      = require('./vectorStore');

class EpisodicMemory {
  constructor() {
    // Layer 1 — structural index: fingerprint key → Episode[] (in memory)
    this.byType = new Map();
    this.ready  = false;
  }

  // "CrashLoopBackOff:false:1:dev" — enough to group structurally identical incidents
  _key(fp) {
    return `${fp.issueType}:${fp.oomKilled}:${fp.exitCode ?? 'n'}:${fp.tier}`;
  }

  _index(episode) {
    const key = this._key(episode.fingerprint);
    if (!this.byType.has(key)) this.byType.set(key, []);
    const arr = this.byType.get(key);
    arr.push(episode);
    if (arr.length > 50) arr.shift();   // keep newest 50 per fingerprint bucket
  }

  // ── Load all resolved episodes from MongoDB at startup ─────────────────────
  async initialize() {
    try {
      const episodes = await IncidentEpisode.find({ resolved: true })
        .sort({ createdAt: -1 })
        .limit(2000)
        .lean();
      for (const ep of episodes) this._index(ep);
      this.ready = true;
      console.log(`[EpisodicMemory] Loaded ${episodes.length} resolved episode(s) into memory index`);
    } catch (err) {
      console.error('[EpisodicMemory] Failed to load from MongoDB:', err.message);
    }
  }

  // ── Layer 1: fast structural lookup — exact fingerprint match ─────────────
  findByFingerprint(fingerprint, limit = 5) {
    const key = this._key(fingerprint);
    const arr = this.byType.get(key) || [];
    return arr.slice(-limit);  // return most recent first
  }

  // ── Layer 2: semantic lookup via Qdrant ────────────────────────────────────
  async findSemantic(queryText, limit = 3) {
    const hits = await vectorStore.search(queryText, limit);
    return hits.map(h => ({ score: h.score, payload: h.payload }));
  }

  // ── Persist a completed episode to MongoDB + Qdrant ────────────────────────
  async store(episodeData) {
    try {
      const qdrantId = randomUUID();
      const doc = new IncidentEpisode({ ...episodeData, qdrantId });
      await doc.save();

      // Add to in-memory index immediately so same-session retrieval works
      this._index(doc.toObject());

      // Push to Qdrant asynchronously — don't block the agent cycle
      if (episodeData.reflection?.rootCause) {
        vectorStore.upsert(qdrantId, { ...episodeData, qdrantId }).catch(() => {});
      }

      console.log(`[EpisodicMemory] Episode stored: ${episodeData.fingerprint?.issueType} resolved=${episodeData.resolved} attempts=${episodeData.totalAttempts}`);
      return doc._id;
    } catch (err) {
      console.error('[EpisodicMemory] store failed:', err.message);
      return null;
    }
  }

  // ── Summary for logging ────────────────────────────────────────────────────
  stats() {
    let total = 0;
    for (const arr of this.byType.values()) total += arr.length;
    return { buckets: this.byType.size, episodes: total };
  }
}

module.exports = new EpisodicMemory();
