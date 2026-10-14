import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createAgentExecutionGatewayServer, InMemoryAgentExecutionGateway, LocalSandboxProvider, GatewayServiceAuthorizer } from '../../src/index.js';
import { SandboxMcpService } from '../../src/mcp/service.js';
import { createMcpHandler } from '../../src/mcp/http.js';

export async function fixture(t, options = {}) {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'partners-mcp-test-'));
  const gateway = new InMemoryAgentExecutionGateway({ provider: new LocalSandboxProvider({ rootDir }), ...options.gateway });
  const authorizer = new GatewayServiceAuthorizer({ tokens: [
    { token: 'full', tenantIds: ['t'], projectIds: ['p'], scopes: ['sessions:create','sessions:read','sessions:write','sessions:delete','jobs:create','jobs:read','jobs:cancel','artifacts:read'] },
    { token: 'read', tenantIds: ['t'], projectIds: ['p'], scopes: ['sessions:read','jobs:read'] },
    { token: 'other', tenantIds: ['other'], projectIds: ['p'], scopes: ['*'] },
  ] });
  const service = new SandboxMcpService({ gateway, authorizer, ...options.service }); await service.initialize();
  const app = createAgentExecutionGatewayServer({ gateway, authorizer, mcpHandler: createMcpHandler({ service, allowedOrigins: ['https://trusted.example'] }) });
  await new Promise(r => app.listen(0, '127.0.0.1', r));
  const url = new URL(`http://127.0.0.1:${app.server.address().port}/mcp`);
  const clients = [];
  async function client(token = 'full') {
    const c = new Client({ name: 'task-weaver-proxy', version: '1.0.0' });
    clients.push(c);
    await c.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    return c;
  }
  t.after(async () => { for (const c of clients) await c.close(); await service.close(); await app.close(); await rm(rootDir, { recursive: true, force: true }); });
  return { client, service, gateway, url, authorizer };
}
