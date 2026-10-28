'use strict';
const { IncidentEpisode, LearnedRule } = require('../db/models');

const PATTERN_THRESHOLD = 3;

class RuleEngine {
  // Get active rules for an issue type
  async getRules(issueType) {
    try {
      return await LearnedRule.find({ issueType, active: true }).lean();
    } catch (err) {
      console.error('[RuleEngine] getRules failed:', err.message);
      return [];
    }
  }

  // Find repeated failure patterns
  async analyze(issueType) {
    try {
      const episodes = await IncidentEpisode
        .find({ 'fingerprint.issueType': issueType })
        .sort({ createdAt: -1 })
        .limit(100)
        .lean();

      const failCounts  = new Map();
      const succCounts  = new Map();
      const failLessons = new Map();

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

        if (failRate < 0.6 || total < PATTERN_THRESHOLD) continue;

        const [type, action] = key.split(':');
        const condition = `${type} + action:${action} + outcome:failed`;

        const sampleWeight = Math.min(total / 20, 1);
        const confidence   = Math.min(0.5 + failRate * 0.45 * sampleWeight, 0.95);

        const lesson = failLessons.get(key) || '';
        const rule   = `Avoid "${action}" for ${type} — failed ${failCount}/${total} times (${Math.round(failRate * 100)}% failure rate).${lesson ? ' ' + lesson : ''}`;

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

  // Get rule stats
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
