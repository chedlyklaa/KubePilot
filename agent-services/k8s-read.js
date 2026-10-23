'use strict';
const { withClusterCredentials } = require('./_bootstrap');
const { startAgent } = require('../src/mesh/agentHost');
const { guardedReadApi } = require('../src/tools/k8sGateway');

// k8s-read gateway — the only path from the LLM agents to cluster READS. Re-runs the
// read-only allowlist (src/tools/readOnlyKubectl.js) and validates every context against
// its own clusters.yaml. Deploy under a read-only (view) Kubernetes identity.
//
// Concurrency 8: the Investigator issues one LLM turn's tool calls concurrently, and
// verifyHealth can poll for up to KUBECTL_WAIT_TIMEOUT — neither should queue behind
// the other. Scale with replicas beyond that.

const api = guardedReadApi();
const version = require('../package.json').version;

startAgent({
  // Optional MCP endpoint (POST /mcp, bearer MCP_AUTH_TOKEN) exposing the same read-only
  // access as MCP tools — see src/mesh/mcpReadServer.js. Read-only by design.
  extendHttp: app => {
    const mounted = require('../src/mesh/mcpReadServer').mountMcp(app, api, { version });
    console.log(`[k8s-read-svc] MCP endpoint: ${mounted ? 'POST /mcp (bearer auth)' : 'off (set MCP_AUTH_TOKEN to enable)'}`);
    return mounted
      ? [{ protocol: 'mcp', transport: 'streamable-http', path: '/mcp', auth: 'bearer', tools: ['list_clusters', 'kubectl_read', 'get_pods', 'get_pod_logs', 'get_nodes'] }]
      : null;
  },
  card: {
    name: 'k8s-read',
    version: require('../package.json').version,
    description: 'Read-only Kubernetes gateway: allowlisted kubectl reads, typed read helpers, post-fix health verification',
    dependsOn: [],
    holdsClusterCredentials: true,
    access: 'read-only',
  },
  init: [withClusterCredentials],
  concurrency: 8,
  handlers: {
    'k8s-read.exec':               { handler: api.exec,               description: 'Allowlisted read-only kubectl subcommand ({command, context}) → output text' },
    'k8s-read.getNodes':           { handler: api.getNodes,           description: 'Node list JSON ({context})' },
    'k8s-read.getDeploymentsFull': { handler: api.getDeploymentsFull, description: 'Deployments JSON ({namespace, context})' },
    'k8s-read.getLogs':            { handler: api.getLogs,            description: 'Pod logs ({podName, namespace, context})' },
    'k8s-read.getPods':            { handler: api.getPods,            description: 'Pod list JSON ({namespace, context})' },
    'k8s-read.verifyHealth':       { handler: api.verifyHealth,       description: 'Poll a fixed resource until healthy or timeout ({step, issue, context}) → {healthy, reason}' },
  },
}).catch(err => { console.error('[k8s-read-svc] failed to start:', err); process.exit(1); });
