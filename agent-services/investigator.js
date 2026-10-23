'use strict';
require('./_bootstrap');
const { startAgent } = require('../src/mesh/agentHost');
const { localAdapter } = require('../src/agents/agentClients');
const { InvestigationReportSchema } = require('../src/orchestrator/schemas');

// Investigator service — the agentic, read-only root-cause loop (src/agents/investigator.js).
// The LLM-heaviest agent, so this is the one to scale out: run N replicas and the bus
// load-balances tasks across them (one task per replica at a time). Holds NO cluster
// credentials: every kubectl read goes to k8s-read (set AGENT_K8S_READ_MODE=remote),
// historical context comes from reflection (AGENT_REFLECTION_MODE=remote), and its
// store writes (token usage, incident stages) are shipped back as mesh effects.

const investigator = localAdapter('investigator');

startAgent({
  card: {
    name: 'investigator',
    version: require('../package.json').version,
    description: 'Agentic read-only root-cause investigation over one incident group',
    dependsOn: ['k8s-read.exec', 'reflection.getContext'],
    holdsClusterCredentials: false,
  },
  handlers: {
    'investigator.investigate': {
      handler: investigator.investigate,
      description: 'Investigate an incident group ({issues, clusterConfigs, fastPathSeed, lastAttemptFailure}) → investigation report',
      output: InvestigationReportSchema,
    },
  },
}).catch(err => { console.error('[investigator-svc] failed to start:', err); process.exit(1); });
