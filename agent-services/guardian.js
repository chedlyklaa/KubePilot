'use strict';
require('./_bootstrap');
const { startAgent } = require('../src/mesh/agentHost');
const { localAdapter } = require('../src/agents/agentClients');
const { GuardianVerdictSchema } = require('../src/orchestrator/schemas');

// Guardian service — independent LLM safety review of each proposed step
// (src/agents/guardianAgent.js). Pure judgment over the evidence it is sent: no cluster
// access and no database. The deterministic overrides around its verdict (root-cause
// gate, live state-drift check, PolicyEngine) stay in graph.js on the orchestrator side.

const guardian = localAdapter('guardian');

startAgent({
  card: {
    name: 'guardian',
    version: require('../package.json').version,
    description: 'Independent safety review of one proposed remediation step',
    dependsOn: [],
    holdsClusterCredentials: false,
  },
  concurrency: 4,
  handlers: {
    'guardian.review': {
      handler: guardian.review,
      description: 'Review one step ({clusterName, tier, review: {issue, diagnosis, podLogs, attempt, rca, reflexionContext}}) → verdict',
      output: GuardianVerdictSchema,
    },
  },
}).catch(err => { console.error('[guardian-svc] failed to start:', err); process.exit(1); });
