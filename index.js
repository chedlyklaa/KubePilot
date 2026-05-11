require('dotenv').config();

const Orchestrator = require('./src/orchestrator/orchestrator');
const ClusterAgent = require('./src/agents/clusterAgent');
const yaml         = require('js-yaml');
const fs           = require('fs');
const path         = require('path');

const CONFIG_PATH = path.join(__dirname, 'config/clusters.yaml');

// ─── Validate environment ───────────────────────────────────────────────────
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('❌  ANTHROPIC_API_KEY is not set.');
  console.error('    export ANTHROPIC_API_KEY=sk-ant-...');
  process.exit(1);
}

// ─── Parse CLI args ─────────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const mode    = args.includes('--benchmark') ? 'benchmark'
              : args.includes('--task')      ? 'task'
              : 'autonomous';

async function main() {
  if (mode === 'autonomous') {
    // Start the full fleet autonomous loop
    const orchestrator = new Orchestrator(CONFIG_PATH);
    const intervalMs = parseInt(process.env.CYCLE_INTERVAL_MS || '300000', 10); // default 5 min
    await orchestrator.start(intervalMs);

  } else if (mode === 'task') {
    // Run a single task against a specific cluster
    const taskIdx   = args.indexOf('--task');
    const task      = args[taskIdx + 1];
    const clusterIdx = args.indexOf('--cluster');
    const clusterName = clusterIdx >= 0 ? args[clusterIdx + 1] : null;

    const config = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const clusterConfig = clusterName
      ? config.clusters.find(c => c.name === clusterName)
      : config.clusters[0];

    if (!clusterConfig) {
      console.error(` Cluster not found: ${clusterName}`);
      process.exit(1);
    }

    console.log(`Running task on ${clusterConfig.name}: "${task}"\n`);
    const agent = new ClusterAgent(clusterConfig);
    const result = await agent.run(task);
    console.log('\nTask complete:', JSON.stringify(result, null, 2));

  } else if (mode === 'benchmark') {
    // Run the evaluation benchmark
    const { runBenchmark } = require('./benchmark/runner/run');
    await runBenchmark();
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
