'use strict';
const { IncidentEpisode, LearnedRule } = require('../db/models');

// How many failures of (issueType, action) before a rule is generated
const PATTERN_THRESHOLD = 3;

class RuleEngine {
  // ── Return all active rules for a given issue type ─────────────────────────
  // Called by PlannerAgent before generating a plan
  async getRules(issueType) {
    try {
      return await LearnedRule.find({ issueType, active: true }).lean();
    } catch (err) {
      console.error('[RuleEngine] getRules failed:', err.message);
      return [];
    }
  }

  // ── Scan recent episodes for repeated failure patterns ─────────────────────
  // Called after each resolved/escalated incident
  async analyze(issueType) {
    try {
      const episodes = await IncidentEpisode
        .find({ 'fingerprint.issueType': issueType })
        .sort({ createdAt: -1 })
        .limit(100)
        .lean();

      // Count failures AND successes per (issueType, action) pair
      const failCounts  = new Map();  // "issueType:action" → fail count
      const succCounts  = new Map();  // "issueType:action" → success count
      const failLessons = new Map();  // "issueType:action" → most recent lesson

      for (const ep of episodes) {
        for (const entry of ep.timeline || []) {
          const k = `${ep.fingerprint.issueType}:${entry.action}`;
          if (entry.outcome === 'failed') {
            failCounts.set(k, (failCounts.get(k) || 0) + 1);
            if (ep.reflection?.lessonsLearned) failLessons.set(k, ep.reflection.lessonsLearned);
          } else if (entry.outcome === 'success') {
            succCounts.set(k, (succCounts.get(k) || 0) + 1);
          }
        }
      }

      for (const [key, failCount] of failCounts) {
        const successCount = succCounts.get(key) || 0;
        const total        = failCount + successCount;
        const failRate     = failCount / total;

        // Only generate a rule when failure rate exceeds 60% with enough samples
        if (failRate < 0.6 || total < PATTERN_THRESHOLD) continue;

        const [type, action] = key.split(':');
        const condition = `${type} + action:${action} + outcome:failed`;

        // Bayesian-inspired confidence: weighted by sample size, scaled to [0.50, 0.95]
        // Small samples stay near 0.5; large samples approach failRate × 0.95
        const sampleWeight = Math.min(total / 20, 1);
        const confidence   = Math.min(0.5 + failRate * 0.45 * sampleWeight, 0.95);

        const lesson = failLessons.get(key) || '';
        const rule   = `Avoid "${action}" for ${type} — failed ${failCount}/${total} times (${Math.round(failRate * 100)}% failure rate).${lesson ? ' ' + lesson : ''}`;

        // Atomic upsert avoids duplicate rules under concurrent analyze() calls.
        // occurrences stores total (fail+success) to stay consistent with the confidence formula.
        await LearnedRule.findOneAndUpdate(
          { issueType: type, condition },
          {
            $set:         { occurrences: total, confidence, rule },
            $setOnInsert: { source: 'pattern_detected', active: true },
          },
          { upsert: true }
        );

        console.log(`[RuleEngine] Rule upserted: ${rule}`);
      }
    } catch (err) {
      console.error('[RuleEngine] analyze failed:', err.message);
    }
  }

  // ── Stats for logging ──────────────────────────────────────────────────────
  async stats() {
    try {
      const total  = await LearnedRule.countDocuments();
      const active = await LearnedRule.countDocuments({ active: true });
      return { total, active };
    } catch {
      return { total: 0, active: 0 };
    }
  }
}

module.exports = new RuleEngine();
