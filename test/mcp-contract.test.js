import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { listMcpTools, parseMcpArguments, MCP_PROTOCOL_VERSION } from '../src/mcp/contract.js';

test('strict tool contract rejects escalation, traversal and unsafe file overwrite', () => {
  for (const args of [
    { sessionId: 's', action: 'write', path: 'x', content: 'hello', requestId: 'request-1' },
    { sessionId: 's', action: 'read', path: '../secret' },
    { sessionId: 's', action: 'read', path: '.env', allowSensitive: true },
    { sessionId: 's', action: 'write', path: 'x', content: 'x'.repeat(262145), requestId: 'request-1', createOnly: true },
  ]) assert.throws(() => parseMcpArguments('file_ops', args), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => parseMcpArguments('bash_exec', { sessionId: 's', command: 'ls', requestId: 'request-1', tenantId: 'other' }));
  assert.equal(parseMcpArguments('bash_exec', { sessionId: 's', command: 'ls', requestId: 'request-1' }).timeoutSeconds, 120);
  assert.equal(listMcpTools().find(t => t.name === 'file_ops').annotations.readOnlyHint, false);
});

test('official SDK used by TW negotiates baseline and discovers all seven contracts', async () => {
  const server = new Server({ name: 'partners-contract', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listMcpTools() }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => ({ content: [{ type: 'text', text: JSON.stringify(parseMcpArguments(params.name, params.arguments)) }] }));
  const client = new Client({ name: 'task-weaver-proxy', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  try {
    await client.connect(b);
    assert.equal(client.getServerVersion().name, 'partners-contract');
    assert.equal((await client.listTools()).tools.length, 7);
    await client.ping();
    const result = await client.callTool({ name: 'bash_exec', arguments: { sessionId: 's', command: 'ls', requestId: 'request-1' } });
    assert.equal(JSON.parse(result.content[0].text).cwd, '.');
    assert.equal(MCP_PROTOCOL_VERSION, '2025-11-25');
  } finally { await client.close(); await server.close(); }
});
