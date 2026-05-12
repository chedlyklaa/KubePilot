// src/memory/consistency.js

/**
 * Cross-Cluster Consistency Checker
 *
 * Detects drift between clusters
 * before applying sensitive actions.
 */

class ConsistencyChecker {
  constructor() {
    // Allowed configuration drift threshold
    this.maxDriftScore = 0.4;
  }

  /**
   * Compare two cluster states
   */
  compareClusters(clusterA, clusterB) {
    const driftReport = {
      clusterA: clusterA.name,
      clusterB: clusterB.name,

      differences: [],

      driftScore: 0,

      consistent: true,
    };

    // ==========================
    // Compare deployments
    // ==========================
    this.compareDeployments(
      clusterA.deployments,
      clusterB.deployments,
      driftReport
    );

    // ==========================
    // Compare node counts
    // ==========================
    this.compareNodes(
      clusterA.nodes,
      clusterB.nodes,
      driftReport
    );

    // ==========================
    // Compare namespaces
    // ==========================
    this.compareNamespaces(
      clusterA.namespaces,
      clusterB.namespaces,
      driftReport
    );

    // Normalize drift score
    driftReport.driftScore = Math.min(
      driftReport.driftScore,
      1
    );

    // Final consistency decision
    driftReport.consistent =
      driftReport.driftScore <=
      this.maxDriftScore;

    return driftReport;
  }

  /**
   * Compare deployments
   */
  compareDeployments(
    deploymentsA,
    deploymentsB,
    report
  ) {
    const namesA = deploymentsA.map((d) => d.name);

    const namesB = deploymentsB.map((d) => d.name);

    // Missing deployments
    for (const deployment of namesA) {
      if (!namesB.includes(deployment)) {
        report.differences.push({
          type: 'missing_deployment',

          deployment,
        });

        report.driftScore += 0.2;
      }
    }

    // Compare replica counts
    deploymentsA.forEach((depA) => {
      const depB = deploymentsB.find(
        (d) => d.name === depA.name
      );

      if (!depB) return;

      if (depA.replicas !== depB.replicas) {
        report.differences.push({
          type: 'replica_mismatch',

          deployment: depA.name,

          clusterA: depA.replicas,

          clusterB: depB.replicas,
        });

        report.driftScore += 0.1;
      }
    });
  }

  /**
   * Compare node counts
   */
  compareNodes(nodesA, nodesB, report) {
    if (nodesA !== nodesB) {
      report.differences.push({
        type: 'node_count_mismatch',

        clusterA: nodesA,

        clusterB: nodesB,
      });

      report.driftScore += 0.15;
    }
  }

  /**
   * Compare namespaces
   */
  compareNamespaces(
    namespacesA,
    namespacesB,
    report
  ) {
    for (const ns of namespacesA) {
      if (!namespacesB.includes(ns)) {
        report.differences.push({
          type: 'missing_namespace',

          namespace: ns,
        });

        report.driftScore += 0.1;
      }
    }
  }

  /**
   * Determine if action is safe
   */
  validateAction(driftReport, action) {
    // Dangerous actions blocked if clusters diverged
    const dangerousActions = [
      'apply_manifest',
      'delete_resource',
      'cluster_upgrade',
      'modify_rbac',
    ];

    if (
      dangerousActions.includes(action) &&
      !driftReport.consistent
    ) {
      return {
        allowed: false,

        reason:
          'Cross-cluster drift detected before sensitive operation',
      };
    }

    return {
      allowed: true,
    };
  }
}

module.exports = new ConsistencyChecker();