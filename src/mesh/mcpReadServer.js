'use strict';
const crypto = require('crypto');
const { z } = require('zod');

// ── MCP endpoint for the k8s-read gateway ──────────────────────────────────
// Exposes KubePilot's read-only cluster access as Model Context Protocol tools, so any
// MCP client (Claude, an IDE, another team's agent) can inspect the managed fleet through
// the SAME gate the Investigator uses: the read-only verb allowlist + Secret block
// (readOnlyKubectl.js), and cluster names resolved against clusters.yaml — a client
// picks a cluster NAME, never a raw kube context.
//
// Deliberately read-only. k8s-write is NOT exposed over MCP: mutation must go through the
// orchestrator's pipeline (Planner → Guardian → PolicyEngine → approvals), and an MCP
// "apply" tool would be a way around all of it.
//
// Off unless MCP_AUTH_TOKEN is set; every request must carry `Authorization: Bearer <it>`.
// Stateless Streamable HTTP: a fresh server + transport per request, no sessions to leak.

function _authorized(req, token) {
  const header = req.headers.authorization ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function _clusters() {
  return require('../config/clusterConfig').getClusters();
}

function _contextFor(clusterName) {
  const c = _clusters().find(x => x.name === clusterName);
  if (!c) throw new Error(`unknown cluster "${clusterName}" — known: ${_clusters().map(x => x.name).join(', ') || '(none)'}`);
  return c.context;
}

const text = s => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 2) }] });
const fail = err => ({ content: [{ type: 'text', text: `ERROR: ${err.message}` }], isError: true });

function buildServer(readApi, { version }) {
  const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
  const server = new McpServer({ name: 'kubepilot-k8s-read', version });
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

  server.registerTool('list_clusters', {
    title: 'List managed clusters',
    description: 'Clusters KubePilot manages (name and tier). Use a name as `clusterName` in the other tools.',
    annotations: readOnly,
  }, async () => text(_clusters().map(c => ({ name: c.name, tier: c.tier ?? 'dev' }))));

  server.registerTool('kubectl_read', {
    title: 'Run a read-only kubectl command',
    description: 'Run one READ-ONLY kubectl subcommand (get/describe/logs/top/explain/api-resources/api-versions/version/cluster-info) ' +
      'against a managed cluster. Give only the subcommand and arguments — no "kubectl", no "--context". Secret values are blocked.',
    inputSchema: {
      clusterName: z.string().describe('Cluster name from list_clusters'),
      command: z.string().describe('e.g. "get pods -n demo -o wide"'),
    },
    annotations: readOnly,
  }, async ({ clusterName, command }) => {
    try {
      const out = await readApi.exec({ command, context: _contextFor(clusterName) });
      return String(out).startsWith('ERROR:') ? { ...text(out), isError: true } : text(out);
    } catch (err) { return fail(err); }
  });

  server.registerTool('get_pods', {
    title: 'List pods with status',
    description: 'Pods in a namespace ("*" for all) with phase, readiness and restart counts.',
    inputSchema: { clusterName: z.string(), namespace: z.string().default('default') },
    annotations: readOnly,
  }, async ({ clusterName, namespace }) => {
    try {
      const pods = await readApi.getPods({ namespace, context: _contextFor(clusterName), asJson: true });
      return text((pods.items ?? []).map(p => ({
        namespace: p.metadata?.namespace,
        name: p.metadata?.name,
        phase: p.status?.phase,
        ready: (p.status?.containerStatuses ?? []).every(c => c.ready),
        restarts: (p.status?.containerStatuses ?? []).reduce((n, c) => n + (c.restartCount ?? 0), 0),
        waiting: (p.status?.containerStatuses ?? []).map(c => c.state?.waiting?.reason).filter(Boolean),
      })));
    } catch (err) { return fail(err); }
  });

  server.registerTool('get_pod_logs', {
    title: 'Get pod logs',
    description: 'Recent logs of a pod.',
    inputSchema: { clusterName: z.string(), namespace: z.string().default('default'), podName: z.string() },
    annotations: readOnly,
  }, async ({ clusterName, namespace, podName }) => {
    try { return text(await readApi.getLogs({ podName, namespace, context: _contextFor(clusterName) })); }
    catch (err) { return fail(err); }
  });

  server.registerTool('get_nodes', {
    title: 'List nodes',
    description: 'Nodes with readiness, schedulability and allocatable capacity.',
    inputSchema: { clusterName: z.string() },
    annotations: readOnly,
  }, async ({ clusterName }) => {
    try {
      const nodes = await readApi.getNodes({ context: _contextFor(clusterName) });
      return text((nodes.items ?? []).map(n => ({
        name: n.metadata?.name,
        ready: (n.status?.conditions ?? []).find(c => c.type === 'Ready')?.status === 'True',
        schedulable: n.spec?.unschedulable !== true,
        allocatable: n.status?.allocatable,
      })));
    } catch (err) { return fail(err); }
  });

  return server;
}

// Mounts POST /mcp on the agent service's Express app. Returns false (and mounts nothing)
// when MCP_AUTH_TOKEN isn't configured.
function mountMcp(app, readApi, { token = process.env.MCP_AUTH_TOKEN, version = '0.0.0', log = console } = {}) {
  if (!token) return false;
  const express = require('express');
  const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');

  app.post('/mcp', express.json({ limit: '256kb' }), async (req, res) => {
    if (!_authorized(req, token)) return res.status(401).json({ error: 'unauthorized' });
    const server = buildServer(readApi, { version });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined }); // stateless
    res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log.error(`[mcp] request failed: ${err.message}`);
      if (!res.headersSent) res.status(500).json({ error: 'internal error' });
    }
  });
  // Stateless server: no SSE stream (GET) and no session teardown (DELETE).
  app.get('/mcp', (_req, res) => res.status(405).set('Allow', 'POST').end());
  app.delete('/mcp', (_req, res) => res.status(405).set('Allow', 'POST').end());
  return true;
}

module.exports = { mountMcp, buildServer };
