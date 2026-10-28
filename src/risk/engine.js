// Scores the risk of an action
class RiskEngine {
  constructor() {
    this.LOW_RISK_THRESHOLD = 0.3;
    this.HIGH_RISK_THRESHOLD = 0.7;
  }

  // Calculate the risk score
  calculateRisk(actionData) {
    const {
      action,
      clusterTier,
      blastRadius,
      reversibility,
      llmConfidence,
      costImpact,
    } = actionData;

    const actionRisk = this.getActionRisk(action);

    const tierMultiplier =
      this.getClusterTierMultiplier(clusterTier);

    const normalizedBlastRadius =
      blastRadius / 10;

    const reversibilityRisk =
      1 - reversibility;

    const confidencePenalty =
      1 - llmConfidence;

    const normalizedCost =
      Math.min(costImpact / 1000, 1);

    let score =
      actionRisk * 0.35 +
      normalizedBlastRadius * 0.2 +
      reversibilityRisk * 0.15 +
      confidencePenalty * 0.15 +
      normalizedCost * 0.15;

    score *= tierMultiplier;

    score = Math.max(0, Math.min(score, 1));

    return {
      score: Number(score.toFixed(2)),
      decision: this.getDecision(score),
    };
  }

  // Risk of an action type
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

  // Risk multiplier for a cluster tier
  getClusterTierMultiplier(tier) {
    const tiers = {
      dev: 0.7,
      staging: 1.0,
      production: 1.3,
    };

    return tiers[tier] || 1;
  }

  // Get the decision for a score
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