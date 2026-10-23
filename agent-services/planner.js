'use strict';
const { withDatabase } = require('./_bootstrap');
const { startAgent } = require('../src/mesh/agentHost');
const { localAdapter } = require('../src/agents/agentClients');
const { PlanSchema } = require('../src/orchestrator/schemas');

// Planner service — multi-step remediation planning (src/agents/planner.js). Validates
// candidate steps with k8s-write.dryRun (--dry-run=server, never mutates) and gathers
// evidence through k8s-read; no cluster credentials. Mongo is only for the capacity-
// forecast cache it attaches as planning context.

const planner = localAdapter('planner');

startAgent({
  card: {
    name: 'planner',
    version: require('../package.json').version,
    description: 'Produces an ordered, dry-run-validated remediation plan for an investigated incident group',
    dependsOn: ['k8s-read.exec', 'k8s-read.getNodes', 'k8s-read.getDeploymentsFull', 'k8s-write.dryRun'],
    holdsClusterCredentials: false,
  },
  init: [withDatabase],
  handlers: {
    'planner.plan': {
      handler: planner.plan,
      description: 'Plan a fix ({issues, rca, clusterConfigs, lastAttemptFailure}) → plan',
      output: PlanSchema,
    },
  },
}).catch(err => { console.error('[planner-svc] failed to start:', err); process.exit(1); });
