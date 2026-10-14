#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const { MCP_URL = 'http://127.0.0.1:8080/mcp', MCP_TOKEN, MCP_TENANT_ID, MCP_PROJECT_ID } = process.env;
if (!MCP_TOKEN || !MCP_TENANT_ID || !MCP_PROJECT_ID) throw new Error('MCP_TOKEN, MCP_TENANT_ID and MCP_PROJECT_ID are required');
const client = new Client({ name: 'partners-mcp-smoke', version: '1.0.0' });
const run = randomUUID(); let sessionId, jobId;
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw Object.assign(new Error('MCP smoke operation failed'), { code: result.structuredContent?.code ?? 'MCP_TOOL_FAILED' });
  return result.structuredContent;
}
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL), { requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } } }));
  if ((await client.listTools()).tools.length !== 7) throw new Error('Tool discovery failed');
  ({ sessionId } = await call('session_create', { tenantId: MCP_TENANT_ID, projectId: MCP_PROJECT_ID, requestId: `smoke-create:${run}` }));
  await call('file_ops', { sessionId, action: 'write', path: 'mcp-smoke.py', content: "print('partners-mcp-ok')", createOnly: true, requestId: `smoke-write:${run}` });
  ({ jobId } = await call('bash_exec', { sessionId, command: 'python3 mcp-smoke.py', requestId: `smoke-exec:${run}`, timeoutSeconds: 30 }));
  const deadline = Date.now() + 60000; let job;
  do {
    job = await call('job_get', { jobId });
    if (job.state === 'succeeded') break;
    await new Promise(r => setTimeout(r, 200));
  } while (Date.now() < deadline);
  if (job.state !== 'succeeded' || job.exitCode !== 0 || !job.stdout.includes('partners-mcp-ok')) throw new Error('Execution verification failed');
  await call('file_ops', { sessionId, action: 'read', path: 'mcp-smoke.py' });
  await call('file_ops', { sessionId, action: 'list', path: '.' });
  await call('session_delete', { sessionId }); sessionId = null;
  console.log(JSON.stringify({ status: 'passed', protocol: '2025-11-25', jobId }));
} finally {
  if (sessionId) {
    if (jobId) await call('job_cancel', { jobId }).catch(() => {});
    await call('session_delete', { sessionId }).catch(error => console.error(JSON.stringify({ cleanup: 'required', sessionId, code: error.code ?? 'CLEANUP_FAILED' })));
  }
  await client.close();
}
