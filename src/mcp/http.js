import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { MCP_PROTOCOL_VERSION, MCP_LIMITS, listMcpTools } from './contract.js';

export function createMcpHandler({ service, allowedOrigins = [], maxRequestBytes = MCP_LIMITS.requestBytes }) {
  const origins = new Set(allowedOrigins);
  return async function handle(req, res) {
    const traceId = randomUUID(); res.setHeader('X-Request-Id', traceId);
    const origin = req.headers.origin;
    if (origin && !origins.has(origin)) return reply(res, 403, 'FORBIDDEN', traceId);
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, MCP-Protocol-Version');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id');
    }
    if (new URL(req.url, 'http://localhost').search) return reply(res, 400, 'INVALID_ARGUMENT', traceId);
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    try { await service.authorizer.authenticate({ headers: req.headers }); }
    catch { return reply(res, 401, 'UNAUTHENTICATED', traceId); }
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST, OPTIONS'); return reply(res, 405, 'METHOD_NOT_ALLOWED', traceId); }
    if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) return reply(res, 415, 'UNSUPPORTED_MEDIA_TYPE', traceId);
    let body;
    try { body = await readBody(req, maxRequestBytes); }
    catch (error) { return reply(res, error.statusCode ?? 400, 'INVALID_ARGUMENT', traceId); }
    const version = body?.method === 'initialize' ? body.params?.protocolVersion : req.headers['mcp-protocol-version'];
    if (version !== MCP_PROTOCOL_VERSION || (req.headers['mcp-protocol-version'] && req.headers['mcp-protocol-version'] !== MCP_PROTOCOL_VERSION)) {
      return reply(res, 400, 'UNSUPPORTED_PROTOCOL_VERSION', traceId);
    }
    const server = new Server({ name: 'partners-sandbox', version: '0.1.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listMcpTools() }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      try {
        const result = await service.call(params.name, params.arguments, req.headers, traceId);
        const output = { ...result, traceId, ...(params.arguments?.requestId ? { requestId: params.arguments.requestId } : {}) };
        return { structuredContent: output, content: [{ type: 'text', text: JSON.stringify(output) }],
          ...(params.name === 'job_get' && ['failed', 'timed_out', 'cancelled'].includes(result.state) ? { isError: true } : {}) };
      } catch (error) {
        const output = { code: error.code ?? 'PROVIDER_UNAVAILABLE', retryable: Boolean(error.retryable), ...error.details, traceId };
        return { isError: true, structuredContent: output, content: [{ type: 'text', text: JSON.stringify(output) }] };
      }
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.once('close', () => { void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };
}
async function readBody(req, max) {
  if (Number(req.headers['content-length']) > max) { req.resume(); throw Object.assign(new Error('Too large'), { statusCode: 413 }); }
  let size = 0; const chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > max) { req.resume(); throw Object.assign(new Error('Too large'), { statusCode: 413 }); }
    chunks.push(chunk);
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
}
function reply(res, status, code, traceId) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ code, traceId })); }
