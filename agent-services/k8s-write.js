'use strict';
const { withClusterCredentials } = require('./_bootstrap');
const { startAgent } = require('../src/mesh/agentHost');
const { guardedWriteApi } = require('../src/tools/k8sGateway');

// k8s-write gateway — the ONLY process that can mutate a cluster. Applies one already-
// approved plan step per task (ordering and rollback stay in graph.js's
// _executeIssueSteps, in the orchestrator), or validates one with --dry-run=server.
// executor.js still enforces PolicyEngine's sanitizer and dry-run mode here, so this
// service fails closed even if a caller is misconfigured.
//
// Run exactly ONE replica: it is the single, auditable point of cluster mutation.
// Concurrency 4 lets steps of unrelated issues proceed in parallel (the orchestrator's
// per-resource locks already keep two workflows off the same resource), and the
// deterministic task ids graph.js sends make a redelivered step replay, not re-apply.

const api = guardedWriteApi();

startAgent({
  card: {
    name: 'k8s-write',
    version: require('../package.json').version,
    description: 'Mutating Kubernetes gateway: apply one approved plan step, or validate it with --dry-run=server',
    dependsOn: [],
    holdsClusterCredentials: true,
    access: 'write',
    replicas: 1,
  },
  init: [withClusterCredentials],
  concurrency: 4,
  handlers: {
    'k8s-write.apply':  { handler: api.apply,  description: 'Apply one plan step ({step, context}); idempotent per task id' },
    'k8s-write.dryRun': { handler: api.dryRun, description: 'Validate one plan step against the API server without applying it ({step, context})' },
  },
}).catch(err => { console.error('[k8s-write-svc] failed to start:', err); process.exit(1); });
