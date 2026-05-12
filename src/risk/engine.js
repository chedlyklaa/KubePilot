// src/risk/engine.js

/**
 * Risk Engine
 * Scores every action before execution
 *
 * Final score:
 * 0.0 → safe
 * 1.0 → dangerous
 */

class RiskEngine {
  constructor() {
    // Risk thresholds
    this.LOW_RISK_THRESHOLD = 0.3;
    this.HIGH_RISK_THRESHOLD = 0.7;
  }

  /**
   * Main scoring function
   */
  calculateRisk(actionData) {
    const {
      action,
      clusterTier,
      blastRadius,
      reversibility,
      llmConfidence,
      costImpact,
    } = actionData;

    // ==========================
    // Base action risk
    // ==========================
    const actionRisk = this.getActionRisk(action);

    // ==========================
    // Cluster tier multiplier
    // ==========================
    const tierMultiplier =
      this.getClusterTierMultiplier(clusterTier);

    // ==========================
    // Blast radius normalization
    // ==========================
    const normalizedBlastRadius =
      blastRadius / 10;

    // ==========================
    // Reversibility impact
    // lower reversibility = higher risk
    // ==========================
    const reversibilityRisk =
      1 - reversibility;

    // ==========================
    // Confidence penalty
    // low confidence = higher risk
    // ==========================
    const confidencePenalty =
      1 - llmConfidence;

    // ==========================
    // Cost normalization
    // ==========================
    const normalizedCost =
      Math.min(costImpact / 1000, 1);

    // ==========================
    // Final weighted score
    // ==========================
    let score =
      actionRisk * 0.35 +
      normalizedBlastRadius * 0.2 +
      reversibilityRisk * 0.15 +
      confidencePenalty * 0.15 +
      normalizedCost * 0.15;

    // Apply environment multiplier
    score *= tierMultiplier;

    // Clamp score
    score = Math.max(0, Math.min(score, 1));

    return {
      score: Number(score.toFixed(2)),
      decision: this.getDecision(score),
    };
  }

  /**
   * Risk associated with action type
   */
  getActionRisk(action) {
    const riskMap = {
      inspect: 0.05,

      get_logs: 0.05,

      restart_pod: 0.15,

      restart_deployment: 0.2,

      scale_small: 0.3,

      scale_large: 0.55,

      apply_manifest: 0.6,

      delete_pod: 0.65,

      scale_to_zero: 0.8,

      delete_resource: 0.9,

      delete_namespace: 0.98,

      cluster_upgrade: 0.95,

      modify_rbac: 0.92,
    };

    return riskMap[action] || 0.5;
  }

  /**
   * Environment sensitivity
   */
  getClusterTierMultiplier(tier) {
    const tiers = {
      dev: 0.7,
      staging: 1.0,
      production: 1.3,
    };

    return tiers[tier] || 1;
  }

  /**
   * Final policy decision
   */
  getDecision(score) {
    if (score < this.LOW_RISK_THRESHOLD) {
      return 'AUTONOMOUS';
    }

    if (score < this.HIGH_RISK_THRESHOLD) {
      return 'NOTIFY';
    }

    return 'BLOCK';
  }
}

module.exports = RiskEngine;