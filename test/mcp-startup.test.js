import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

test('service entrypoint enables authenticated MCP explicitly and reports readiness', { timeout: 7000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'partners-startup-test-'));
  const token = randomUUID();
  const child = spawn(process.execPath, ['scripts/gateway-service.mjs'], { env: {
    PATH: process.env.PATH, GATEWAY_HOST: '127.0.0.1', GATEWAY_PORT: '0', GATEWAY_PROVIDER: 'local',
    GATEWAY_MCP_ENABLED: '1', GATEWAY_MCP_ALLOW_LOCAL: '1', GATEWAY_SERVICE_TOKEN: token,
    GATEWAY_WORK_ROOT: root, GATEWAY_ARTIFACT_ROOT: path.join(root, 'artifacts'),
    GATEWAY_SERVICE_SCOPES: 'sessions:create,sessions:read,sessions:delete,jobs:create,jobs:read,jobs:cancel',
    GATEWAY_TENANT_IDS: 't', GATEWAY_PROJECT_IDS: 'p',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  const client = new Client({ name: 'entrypoint-test', version: '1.0.0' });
  let logs = '', errors = '';
  child.stderr.on('data', x => { errors += x; });
  t.after(async () => { await client.close(); child.kill('SIGTERM'); if (child.exitCode == null) await new Promise(r => child.once('exit', r)); await rm(root, { force: true, recursive: true }); });
  const started = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Startup deadline')), 4000);
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Startup failed: ' + errors)); });
    child.stdout.on('data', data => {
      logs += data;
      for (const line of logs.split('\n')) {
        try { const row = JSON.parse(line); if (row.message === 'gateway started') { clearTimeout(timer); resolve(row); } } catch {}
      }
    });
  });
  const url = new URL(`http://127.0.0.1:${started.port}/mcp`);
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  assert.equal((await client.listTools()).tools.length, 7);
  const ready = await (await fetch(new URL('/ready', url))).json();
  assert.equal(ready.mcp.enabled, true);
  assert.equal(ready.mcp.protocolVersion, '2025-11-25');
  assert.equal(logs.includes(token), false);
});
