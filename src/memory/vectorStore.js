'use strict';
require('dotenv').config({ override: true });
const { QdrantClient } = require('@qdrant/js-client-rest');
const OpenAI           = require('openai');

const COLLECTION = 'incident_episodes';

class VectorStore {
  constructor() {
    this.client = new QdrantClient({
      url: process.env.QDRANT_URL || 'http://localhost:6333',
      ...(process.env.QDRANT_API_KEY ? { apiKey: process.env.QDRANT_API_KEY } : {}),
    });

    this.embedClient = new OpenAI({
      apiKey:  process.env.EMBEDDING_API_KEY  || process.env.OPENAI_API_KEY,
      baseURL: process.env.EMBEDDING_BASE_URL || process.env.OPENAI_BASE_URL,
    });

    this.embeddingModel = process.env.EMBEDDING_MODEL || 'bge-multilingual-gemma2';
    this.vectorSize     = null;   // discovered at init from a live embedding call
    this.ready          = false;
  }

  // ── Startup ────────────────────────────────────────────────────────────────
  async initialize() {
    try {
      // Step 1: ask the model itself how many dimensions it produces
      // 10-second timeout — if the embedding API is unreachable at boot, degrade gracefully
      console.log(`[VectorStore] Probing embedding model "${this.embeddingModel}"…`);
      const probe = await Promise.race([
        this.generateEmbedding('kubernetes pod issue probe'),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('embedding probe timed out (10 s)')), 10_000)
        ),
      ]);
      this.vectorSize = probe.length;
      console.log(`[VectorStore] Embedding dimension: ${this.vectorSize}`);

      // Step 2: check if the collection already exists
      const { collections } = await this.client.getCollections();
      const existing = collections.find(c => c.name === COLLECTION);

      if (existing) {
        // Fetch the collection's configured vector size
        const info        = await this.client.getCollection(COLLECTION);
        const storedSize  = info.config?.params?.vectors?.size ?? null;

        if (storedSize !== null && storedSize !== this.vectorSize) {
          // Dimension mismatch — delete and recreate so every vector is consistent
          console.warn(`[VectorStore] Dimension mismatch: collection=${storedSize}, model=${this.vectorSize} — recreating collection`);
          await this.client.deleteCollection(COLLECTION);
          await this._createCollection();
        } else {
          console.log(`[VectorStore] Collection "${COLLECTION}" ready (dim=${this.vectorSize})`);
        }
      } else {
        await this._createCollection();
      }

      this.ready = true;
    } catch (err) {
      console.error('[VectorStore] Init failed:', err.message);
      console.warn(`[VectorStore] Semantic search disabled — QDRANT_URL=${process.env.QDRANT_URL || 'http://localhost:6333'}`);
    }
  }

  async _createCollection() {
    await this.client.createCollection(COLLECTION, {
      vectors: { size: this.vectorSize, distance: 'Cosine' },
    });
    console.log(`[VectorStore] Collection "${COLLECTION}" created (dim=${this.vectorSize})`);
  }

  // ── Generate embedding vector ──────────────────────────────────────────────
  async generateEmbedding(text) {
    const res = await this.embedClient.embeddings.create({
      model: this.embeddingModel,
      input: text,
    });
    return res.data[0].embedding;
  }

  // ── Build rich text from a stored episode (used at write time) ─────────────
  episodeToText(episode) {
    const f = episode.fingerprint || {};
    const c = episode.context     || {};
    const r = episode.reflection  || {};
    return [
      `issueType:${f.issueType} oomKilled:${f.oomKilled} exitCode:${f.exitCode ?? 'none'} tier:${f.tier}`,
      `deployment:${c.deployment || 'none'} namespace:${c.namespace || 'default'} restartCount:${c.restartCount ?? 0}`,
      c.logSnippet     ? `logs:${c.logSnippet.slice(0, 400)}`    : '',
      r.rootCause      ? `rootCause:${r.rootCause}`              : '',
      r.lessonsLearned ? `lesson:${r.lessonsLearned}`            : '',
      episode.resolvedAction ? `resolvedAction:${episode.resolvedAction}` : '',
    ].filter(Boolean).join('\n');
  }

  // ── Build query text from a live issue (used at search time) ──────────────
  issueToQueryText(issue, podLogs = '') {
    return [
      `issueType:${issue.type} oomKilled:${issue.oomKilled ?? false} exitCode:${issue.exitCode ?? 'none'} tier:${issue.tier || 'dev'}`,
      `deployment:${issue.deployment || 'none'} namespace:${issue.namespace || 'default'} restartCount:${issue.restartCount ?? 0}`,
      podLogs ? `logs:${podLogs.slice(-400)}` : '',
    ].filter(Boolean).join('\n');
  }

  // ── Upsert one episode vector ──────────────────────────────────────────────
  async upsert(qdrantId, episode) {
    if (!this.ready) return;
    try {
      const text   = this.episodeToText(episode);
      const vector = await this.generateEmbedding(text);

      await this.client.upsert(COLLECTION, {
        points: [{
          id:      qdrantId,
          vector,
          payload: {
            issueType:      episode.fingerprint?.issueType ?? '',
            tier:           episode.fingerprint?.tier      ?? '',
            resolvedAction: episode.resolvedAction         ?? null,
            resolved:       episode.resolved               ?? false,
            ts:             new Date().toISOString(),
          },
        }],
      });
      console.log(`[VectorStore] Vector upserted: ${qdrantId}`);
    } catch (err) {
      console.error('[VectorStore] upsert failed:', err.message);
    }
  }

  // ── Semantic similarity search ─────────────────────────────────────────────
  async search(queryText, limit = 4) {
    if (!this.ready) return [];
    try {
      const vector = await this.generateEmbedding(queryText);
      return await this.client.search(COLLECTION, {
        vector,
        limit,
        with_payload: true,
      });
    } catch (err) {
      console.error('[VectorStore] search failed:', err.message);
      return [];
    }
  }
}

module.exports = new VectorStore();
