import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const express = require('express');
const { mountMcp } = require('./mcpReadServer.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { getClusters } = require('../config/clusterConfig.js');

// Real MCP client ↔ real MCP endpoint over HTTP; only the read API underneath is faked,
// so no cluster is ever touched.
const TOKEN = 'test-only-mcp-token';
const calls = [];
const fakeReadApi = {
  exec:    async ({ command, context }) => { calls.push({ command, context }); return command.startsWith('delete') ? 'ERROR: command blocked — verb "delete" is not on the read-only allowlist' : `ran ${command}`; },
  getPods: async () => ({ items: [{ metadata: { namespace: 'demo', name: 'api-1' }, status: { phase: 'Running', containerStatuses: [{ ready: true, restartCount: 2, state: {} }] } }] }),
  getLogs: async () => 'log line',
  getNodes: async () => ({ items: [] }),
};

let server, url;
beforeAll(async () => {
  const app = express();
  expect(mountMcp(app, fakeReadApi, { token: TOKEN, version: 'test' })).toBe(true);
  server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  url = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
});
afterAll(() => server?.close());

async function connect(token) {
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

describe('k8s-read MCP endpoint', () => {
  it('is not mounted without a token', () => {
    expect(mountMcp(express(), fakeReadApi, { token: undefined })).toBe(false);
  });

  it('rejects a wrong bearer token', async () => {
    await expect(connect('wrong')).rejects.toThrow();
  });

  it('lists only read-only tools', async () => {
    const client = await connect(TOKEN);
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name).sort()).toEqual(['get_nodes', 'get_pod_logs', 'get_pods', 'kubectl_read', 'list_clusters']);
    expect(tools.every(t => t.annotations?.readOnlyHint === true)).toBe(true);
    await client.close();
  });

  it('resolves a cluster NAME to its context server-side and runs the read', async () => {
    const cluster = getClusters()[0];
    const client = await connect(TOKEN);
    const res = await client.callTool({ name: 'kubectl_read', arguments: { clusterName: cluster.name, command: 'get pods -n demo' } });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toBe('ran get pods -n demo');
    expect(calls.at(-1)).toEqual({ command: 'get pods -n demo', context: cluster.context });
    await client.close();
  });

  it('flags gate rejections and unknown clusters as tool errors', async () => {
    const client = await connect(TOKEN);
    const blocked = await client.callTool({ name: 'kubectl_read', arguments: { clusterName: getClusters()[0].name, command: 'delete pod x' } });
    expect(blocked.isError).toBe(true);
    const unknown = await client.callTool({ name: 'get_pods', arguments: { clusterName: 'prod-forged', namespace: 'x' } });
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0].text).toMatch(/unknown cluster/);
    await client.close();
  });

  it('summarizes pods instead of dumping raw objects', async () => {
    const client = await connect(TOKEN);
    const res = await client.callTool({ name: 'get_pods', arguments: { clusterName: getClusters()[0].name, namespace: 'demo' } });
    expect(JSON.parse(res.content[0].text)).toEqual([{ namespace: 'demo', name: 'api-1', phase: 'Running', ready: true, restarts: 2, waiting: [] }]);
    await client.close();
  });
});
