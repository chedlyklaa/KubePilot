// src/agents/clusterAgent.js

const kubectl = require('../tools/kubectl');

/**
 * ClusterAgent
 * One autonomous agent per AKS cluster
 */
class ClusterAgent {
  constructor(clusterConfig) {
    this.name = clusterConfig.name;
    this.context = clusterConfig.context;
    this.tier = clusterConfig.tier;
  }

  /**
   * Main execution loop
   */
  async run() {
    console.log(`\n====================================`);
    console.log(`[${this.name}] Agent started`);
    console.log(`====================================`);

    try {
      // 1. Inspect cluster
      const pods = await this.inspectCluster();

      // 2. Detect problems
      const issues = await this.detectIssues(pods);

      // 3. Resolve issues
      for (const issue of issues) {
        await this.handleIssue(issue);
      }

      console.log(`[${this.name}] Agent cycle completed`);
    } catch (error) {
      console.error(`[${this.name}] ERROR:`, error);
    }
  }

  /**
   * Get cluster state
   */
  async inspectCluster() {
    console.log(`[${this.name}] Inspecting cluster...`);

    const pods = await kubectl.getPods('default', this.context);

    console.log(`[${this.name}] Current pods:\n`);
    console.log(pods);

    return pods;
  }

  /**
   * Detect cluster issues
   */
  async detectIssues(podsOutput) {
    console.log(`\n[${this.name}] Analyzing cluster state...`);

    const issues = [];

    // Simple detection example
    if (podsOutput.includes('CrashLoopBackOff')) {
      issues.push({
        type: 'CrashLoopBackOff',
        severity: 'medium',
        action: 'restart_deployment',
        deployment: 'api-server',
        namespace: 'default',
      });
    }

    if (podsOutput.includes('ImagePullBackOff')) {
      issues.push({
        type: 'ImagePullBackOff',
        severity: 'high',
        action: 'notify_human',
      });
    }

    if (issues.length === 0) {
      console.log(`[${this.name}] No issues detected`);
    } else {
      console.log(
        `[${this.name}] ${issues.length} issue(s) detected`
      );
    }

    return issues;
  }

  /**
   * Decide and execute remediation
   */
  async handleIssue(issue) {
    console.log(`\n[${this.name}] Handling issue: ${issue.type}`);

    switch (issue.action) {
      case 'restart_deployment':
        await this.restartDeployment(issue);
        break;

      case 'notify_human':
        console.log(
          `[${this.name}] Human escalation required`
        );
        break;

      default:
        console.log(
          `[${this.name}] Unknown action: ${issue.action}`
        );
    }
  }

  /**
   * Restart deployment remediation
   */
  async restartDeployment(issue) {
    console.log(
      `[${this.name}] Restarting deployment: ${issue.deployment}`
    );

    try {
      const result =
        await kubectl.restartDeployment(
          issue.deployment,
          issue.namespace,
          this.context
        );

      console.log(`[${this.name}] Restart successful`);
      console.log(result);
    } catch (error) {
      console.error(
        `[${this.name}] Restart failed:`,
        error
      );
    }
  }
}

module.exports = ClusterAgent;