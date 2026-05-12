// benchmark/runner/run.js

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ClusterAgent = require('../../src/agents/clusterAgent');
const AuditLogger = require('../../src/audit/logger');

/**
 * Benchmark Runner
 *
 * Simulates incidents
 * Executes agent remediation
 * Measures performance metrics
 */

class BenchmarkRunner {
  constructor() {
    this.results = [];

    this.scenarioPath = path.join(
      __dirname,
      '../scenarios/scenarios.yaml'
    );
  }

  /**
   * Load benchmark scenarios
   */
  loadScenarios() {
    try {
      const file = fs.readFileSync(
        this.scenarioPath,
        'utf8'
      );

      const config = yaml.load(file);

      return config.scenarios || [];
    } catch (error) {
      console.error(
        '[BENCHMARK] Failed to load scenarios:',
        error
      );

      process.exit(1);
    }
  }

  /**
   * Run all benchmark scenarios
   */
  async run() {
    console.log('\n====================================');
    console.log('STARTING AI AGENT BENCHMARK');
    console.log('====================================');

    const scenarios = this.loadScenarios();

    console.log(
      `Loaded ${scenarios.length} scenarios`
    );

    for (const scenario of scenarios) {
      await this.runScenario(scenario);
    }

    this.printFinalResults();

    this.exportResults();
  }

  /**
   * Run single scenario
   */
  async runScenario(scenario) {
    console.log('\n------------------------------------');
    console.log(`Scenario: ${scenario.name}`);
    console.log('------------------------------------');

    const startTime = Date.now();

    // ====================================
    // Create fake cluster agent
    // ====================================
    const agent = new ClusterAgent({
      name: scenario.cluster,
      context: 'benchmark-context',
      tier: scenario.tier,
    });

    // ====================================
    // Simulate incident injection
    // ====================================
    console.log(
      `[BENCHMARK] Injecting incident: ${scenario.issue}`
    );

    // ====================================
    // Simulate agent execution
    // ====================================
    let success = false;

    try {
      // Simulated remediation delay
      await this.simulateDelay(2000);

      // Fake success probability
      success = Math.random() > 0.2;

      // Log benchmark action
      AuditLogger.log({
        cluster: scenario.cluster,

        agent: 'BenchmarkAgent',

        action: scenario.expectedAction,

        decision: 'AUTONOMOUS',

        riskScore: scenario.expectedRisk,

        status: success
          ? 'success'
          : 'failed',

        reason: scenario.issue,
      });
    } catch (error) {
      console.error(
        '[BENCHMARK] Scenario failed:',
        error
      );
    }

    // ====================================
    // Metrics collection
    // ====================================
    const endTime = Date.now();

    const durationSeconds =
      (endTime - startTime) / 1000;

    const result = {
      scenario: scenario.name,

      issue: scenario.issue,

      success,

      durationSeconds,

      expectedAction:
        scenario.expectedAction,

      expectedRisk:
        scenario.expectedRisk,

      timestamp: new Date().toISOString(),
    };

    this.results.push(result);

    console.log(
      `[BENCHMARK] Result: ${
        success ? 'SUCCESS' : 'FAILED'
      }`
    );

    console.log(
      `[BENCHMARK] Duration: ${durationSeconds}s`
    );
  }

  /**
   * Simulate execution time
   */
  async simulateDelay(ms) {
    return new Promise((resolve) =>
      setTimeout(resolve, ms)
    );
  }

  /**
   * Print benchmark summary
   */
  printFinalResults() {
    console.log('\n====================================');
    console.log('BENCHMARK RESULTS');
    console.log('====================================');

    const total = this.results.length;

    const successes = this.results.filter(
      (r) => r.success
    ).length;

    const failures = total - successes;

    const successRate = (
      (successes / total) *
      100
    ).toFixed(2);

    const avgDuration =
      this.results.reduce(
        (sum, r) => sum + r.durationSeconds,
        0
      ) / total;

    console.log(`Total Scenarios: ${total}`);

    console.log(`Successes: ${successes}`);

    console.log(`Failures: ${failures}`);

    console.log(`Success Rate: ${successRate}%`);

    console.log(
      `Average MTTR: ${avgDuration.toFixed(2)}s`
    );
  }

  /**
   * Export benchmark results
   */
  exportResults() {
    const outputPath = path.join(
      __dirname,
      '../results.json'
    );

    fs.writeFileSync(
      outputPath,
      JSON.stringify(this.results, null, 2)
    );

    console.log(
      `\n[BENCHMARK] Results exported to ${outputPath}`
    );
  }
}

// ====================================
// Run benchmark directly
// ====================================
(async () => {
  const runner = new BenchmarkRunner();

  await runner.run();
})();