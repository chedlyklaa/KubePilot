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

      // Count failures per (issueType, action) pair across all episodes
      const failCounts  = new Map();  // "issueType:action" → count
      const failLessons = new Map();  // "issueType:action" → most recent lesson

      for (const ep of episodes) {
        for (const entry of ep.timeline || []) {
          if (entry.outcome !== 'failed') continue;
          const k = `${ep.fingerprint.issueType}:${entry.action}`;
          failCounts.set(k, (failCounts.get(k) || 0) + 1);
          if (ep.reflection?.lessonsLearned) failLessons.set(k, ep.reflection.lessonsLearned);
        }
      }

      for (const [key, count] of failCounts) {
        if (count < PATTERN_THRESHOLD) continue;

        const [type, action] = key.split(':');
        const condition = `${type} + action:${action} + outcome:failed`;

        // Increment if rule already exists
        const existing = await LearnedRule.findOne({ issueType: type, condition });
        if (existing) {
          await LearnedRule.updateOne(
            { _id: existing._id },
            { $set: { occurrences: count, confidence: Math.min(0.5 + count * 0.08, 0.95) } }
          );
          continue;
        }

        // Generate new rule
        const lesson = failLessons.get(key) || '';
        const rule   = `Avoid "${action}" for ${type} — failed ${count}+ times.${lesson ? ' ' + lesson : ''}`;

        await LearnedRule.create({
          issueType:   type,
          condition,
          rule,
          source:      'pattern_detected',
          occurrences: count,
          confidence:  Math.min(0.5 + count * 0.08, 0.95),
          active:      true,
        });

        console.log(`[RuleEngine] New rule: ${rule}`);
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
