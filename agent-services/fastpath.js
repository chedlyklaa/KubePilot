'use strict';
require('./_bootstrap');
const { startAgent } = require('../src/mesh/agentHost');
const { localAdapter } = require('../src/agents/agentClients');

// Fast Path service — bounded single-shot diagnosis for SIMPLE incidents
// (src/agents/fastPath.js). Reads evidence through k8s-read; no cluster credentials.

const fastPath = localAdapter('fastpath');

startAgent({
  card: {
    name: 'fastpath',
    version: require('../package.json').version,
    description: 'Bounded, single-pass diagnosis for SIMPLE single-pod incidents; escalates to the Investigator when unsure',
    dependsOn: ['k8s-read.exec'],
    holdsClusterCredentials: false,
  },
  concurrency: 2,
  handlers: {
    'fastpath.diagnose': {
      handler: fastPath.diagnose,
      description: 'Diagnose one SIMPLE incident ({issue, clusterConfigs}) → {escalate, reason, diagnosis, evidenceBundle, toolCallCount}',
    },
  },
}).catch(err => { console.error('[fastpath-svc] failed to start:', err); process.exit(1); });
