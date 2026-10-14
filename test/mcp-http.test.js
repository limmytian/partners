import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createAgentExecutionGatewayServer, InMemoryAgentExecutionGateway, LocalSandboxProvider, GatewayServiceAuthorizer } from '../src/index.js';
import { SandboxMcpService } from '../src/mcp/service.js';
import { createMcpHandler } from '../src/mcp/http.js';

import { fixture } from './helpers/mcp-fixture.js';

const create = { tenantId: 't', projectId: 'p', requestId: 'create-001' };
function result(response) { if (response.isError) throw new Error(JSON.stringify(response)); return response.structuredContent; }
async function call(client, name, args) { return result(await client.callTool({ name, arguments: args })); }

test('official HTTP client discovers tools, submits once and reconnects to poll', async t => {
  const f = await fixture(t), c = await f.client();
  assert.equal((await c.listTools()).tools.length, 7); await c.ping();
  const session = await call(c, 'session_create', create);
  assert.equal((await call(c, 'session_create', create)).sessionId, session.sessionId);
  const args = { sessionId: session.sessionId, command: 'printf hello', requestId: 'exec-0001' };
  const accepted = await call(c, 'bash_exec', args);
  assert.equal((await call(c, 'bash_exec', args)).jobId, accepted.jobId);
  await c.close(); await f.service.running.get(accepted.jobId);
  const reconnected = await f.client();
  const job = await call(reconnected, 'job_get', { jobId: accepted.jobId });
  assert.equal(job.state, 'succeeded'); assert.equal(job.exitCode, 0); assert.match(job.stdout, /hello/);
  const reader = await f.client('read');
  const noWrite = await reader.callTool({ name: 'bash_exec', arguments: { ...args, requestId: 'exec-0002' } });
  assert.equal(noWrite.structuredContent.code, 'FORBIDDEN');
  const other = await f.client('other');
  assert.equal((await other.callTool({ name: 'session_get', arguments: { sessionId: session.sessionId } })).structuredContent.code, 'FORBIDDEN');
  await call(reconnected, 'session_delete', { sessionId: session.sessionId });
});

test('transport rejects token, Origin, protocol version and oversized requests', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.url)).status, 401);
  const headers = { Authorization: 'Bearer full', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  assert.equal((await fetch(f.url, { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body: '{}' })).status, 403);
  assert.equal((await fetch(f.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2026-07-28' } }) })).status, 400);
  assert.equal((await fetch(f.url, { method: 'POST', headers, body: 'x'.repeat(1048577) })).status, 413);
  assert.equal((await fetch(f.url, { headers: { Authorization: 'Bearer full' } })).status, 405);
});
