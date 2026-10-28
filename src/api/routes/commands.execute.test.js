import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';

process.env.OPENAI_API_KEY ??= 'test-only-not-a-real-key';
process.env.OPENAI_MODEL ??= 'test-model';
process.env.NOTIFICATION_SECRET ??= 'test-only-secret-not-a-real-value-0123456789';

const require = createRequire(import.meta.url);

const USERS = {
  'admin-token':  { id: 'u1', name: 'Admin', email: 'admin@example.com', role: 'admin' },
  'viewer-token': { id: 'u2', name: 'Viewer', email: 'viewer@example.com', role: 'viewer' },
};

let server, base, ran;
let restore = [];

beforeAll(async () => {
  const express = require('express');
  const authService = require('../authService.js');
  const permissionService = require('../../services/permissionService.js');
  const kubectl = require('../../tools/kubectl.js');
  const clusterConfig = require('../../config/clusterConfig.js');

  const stub = (obj, key, fn) => { const orig = obj[key]; obj[key] = fn; restore.push(() => { obj[key] = orig; }); };
  stub(authService, 'getUser', token => USERS[token] ?? null);
  stub(permissionService, 'loadPermissions', async () => [{ cluster: 'dev', namespace: 'shop', role: 'viewer' }]);
  stub(kubectl, 'runCommand', async (cmd, opts) => { ran.push({ cmd, opts }); return 'ok'; });
  stub(clusterConfig, 'getClusters', () => [{ name: 'dev', context: 'dev-ctx' }]);

  const app = express();
  app.use(express.json());
  app.use(require('./commands.routes.js'));
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => {
  server?.close();
  for (const r of restore.reverse()) r();
});

async function execute(command, token) {
  ran = [];
  const res = await fetch(`${base}/api/command/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ command }),
  });
  return { status: res.status, body: await res.json() };
}

describe('POST /api/command/execute', () => {
  it('rejects a request without a login', async () => {
    const { status } = await execute('kubectl --context=dev-ctx get pods -n shop');
    expect(status).toBe(401);
    expect(ran).toHaveLength(0);
  });

  it('blocks a command the policy sanitizer rejects', async () => {
    const { status, body } = await execute('kubectl --context=dev-ctx delete pod api-1 -n shop --force', 'admin-token');
    expect(status).toBe(400);
    expect(body.error).toMatch(/blocked by policy/);
    expect(ran).toHaveLength(0);
  });

  it('runs an admin command as the server identity (no impersonation)', async () => {
    const { status } = await execute('kubectl --context=dev-ctx get pods -n shop', 'admin-token');
    expect(status).toBe(200);
    expect(ran).toEqual([{ cmd: 'kubectl --context=dev-ctx get pods -n shop', opts: { impersonateAs: null } }]);
  });

  it('runs an in-scope non-admin command impersonated as that user', async () => {
    const { status } = await execute('kubectl --context=dev-ctx get pods -n shop', 'viewer-token');
    expect(status).toBe(200);
    expect(ran[0].opts).toEqual({ impersonateAs: 'viewer@example.com' });
  });

  it('refuses a non-admin command outside the user\'s scope', async () => {
    const { status } = await execute('kubectl --context=dev-ctx delete pod api-1 -n shop', 'viewer-token');
    expect(status).toBe(403);
    expect(ran).toHaveLength(0);
  });

  it('refuses a non-admin command with no --context (scope can\'t be checked)', async () => {
    const { status, body } = await execute('kubectl get pods -n shop', 'viewer-token');
    expect(status).toBe(403);
    expect(body.error).toMatch(/missing --context/);
    expect(ran).toHaveLength(0);
  });
});
