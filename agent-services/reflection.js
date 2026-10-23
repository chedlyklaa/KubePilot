'use strict';
const { withDatabase } = require('./_bootstrap');
const { startAgent } = require('../src/mesh/agentHost');
const { localAdapter } = require('../src/agents/agentClients');

// Reflection service — sole owner of the knowledge base (architecture-doc §3.7): serves
// historical context (getContext), post-incident analysis (reflect), and is the only
// writer of new episodes (remember). Keeping reads AND writes here matters:
// episodicMemory indexes resolved episodes in memory at boot, so an episode written by
// any other process would never reach this service's index. Run ONE replica for the
// same reason.

const reflection = localAdapter('reflection');

startAgent({
  card: {
    name: 'reflection',
    version: require('../package.json').version,
    description: 'Knowledge-base owner: learned rules and incident history (read + write) and post-incident reflection',
    dependsOn: [],
    holdsClusterCredentials: false,
    replicas: 1,
  },
  init: [
    withDatabase,
    () => require('../src/memory/vectorStore').initialize(),
    () => require('../src/memory/episodicMemory').initialize(),
  ],
  concurrency: 4,
  handlers: {
    'reflection.getContext': { handler: reflection.getContext, description: 'Rules + structural/semantic history for an issue ({fingerprint, queryText, issueType})' },
    'reflection.reflect':    { handler: reflection.reflect,    description: 'Post-incident analysis ({issue, planAction, rootCauseDiagnosis, resolved, podLogs, rca, overrideData})' },
    'reflection.remember':   { handler: reflection.remember,   description: 'Store a finished incident episode; idempotent per task id' },
  },
}).catch(err => { console.error('[reflection-svc] failed to start:', err); process.exit(1); });
