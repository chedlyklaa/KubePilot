// src/orchestrator/index.js

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ClusterAgent = require('../agents/clusterAgent');

/**
 * FleetOrchestrator
 * Central brain managing all cluster agents
 */
class FleetOrchestrator {
  constructor() {
    this.clusterAgents = [];
    this.configPath = path.join(
      __dirname,
      '../../config/clusters.yaml'
    );
  }

  /**
   * Load cluster configuration
   */
  loadClusterConfig() {
    try {
      console.log('\nLoading cluster configuration...');

      const file = fs.readFileSync(this.configPath, 'utf8');

      const config = yaml.load(file);

      return config.clusters || [];
    } catch (error) {
      console.error(
        'Failed to load cluster configuration:',
        error.message
      );

      process.exit(1);
    }
  }

  /**
   * Create one agent per cluster
   */
  initializeAgents() {
    console.log('\nInitializing cluster agents...');

    const clusters = this.loadClusterConfig();

    this.clusterAgents = clusters.map((cluster) => {
      console.log(
        `Creating agent for cluster: ${cluster.name}`
      );

      return new ClusterAgent(cluster);
    });

    console.log(
      `\n${this.clusterAgents.length} cluster agent(s) initialized`
    );
  }

  /**
   * Execute all agents
   */
  async runFleetCycle() {
    console.log('\n====================================');
    console.log('FLEET ORCHESTRATOR CYCLE STARTED');
    console.log('====================================');

    const startTime = Date.now();

    try {
      // Run all agents sequentially
      for (const agent of this.clusterAgents) {
        await agent.run();
      }

      const duration = (
        (Date.now() - startTime) /
        1000
      ).toFixed(2);

      console.log('\n====================================');
      console.log('FLEET CYCLE COMPLETED');
      console.log(`Duration: ${duration}s`);
      console.log('====================================');
    } catch (error) {
      console.error(
        '\nFleet orchestration failed:',
        error
      );
    }
  }

  /**
   * Start orchestrator
   */
  async start() {
    console.log('\n====================================');
    console.log('STARTING AKS FLEET ORCHESTRATOR');
    console.log('====================================');

    // Initialize cluster agents
    this.initializeAgents();

    // Run first cycle immediately
    await this.runFleetCycle();

    // Schedule every 5 minutes
    setInterval(async () => {
      await this.runFleetCycle();
    }, 5 * 60 * 1000);
  }
}

module.exports = FleetOrchestrator;