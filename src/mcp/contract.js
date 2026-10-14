import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

export const MCP_PROTOCOL_VERSION = '2025-11-25';
export const MCP_LIMITS = Object.freeze({
  requestBytes: 1048576, fileWriteBytes: 262144, outputBytes: 16384,
  maxOutputBytes: 65536, timeoutSeconds: 120, maxTimeoutSeconds: 900,
  idleSeconds: 1800, lifetimeSeconds: 28800, graceSeconds: 30,
  tenantSessions: 10, tenantJobs: 20,
});
const id = z.string().min(1).max(200);
const requestId = z.string().min(8).max(200).regex(/^[A-Za-z0-9._~:-]+$/);
const relativePath = z.string().min(1).max(1024).refine(value =>
  !value.includes('\0') && !value.startsWith('/') && !value.includes('\\') &&
  !value.split('/').includes('..'), 'Expected a relative workspace path');
const sessionId = { sessionId: id };
const bytes = z.number().int().min(4).max(MCP_LIMITS.maxOutputBytes);
const write = z.object({ ...sessionId, action: z.literal('write'), path: relativePath,
  content: z.string().refine(s => Buffer.byteLength(s) <= MCP_LIMITS.fileWriteBytes, 'File is too large'),
  requestId, expectedHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), createOnly: z.boolean().optional(),
}).strict().refine(v => (v.createOnly === true) !== (v.expectedHash !== undefined),
  'Specify exactly one of createOnly=true or expectedHash');
const fileOps = z.union([
  z.object({ ...sessionId, action: z.literal('list'), path: relativePath.default('.'),
    depth: z.number().int().min(0).max(5).default(3), cursor: z.string().max(2048).optional(),
    limit: z.number().int().min(1).max(500).default(100), }).strict(),
  z.object({ ...sessionId, action: z.literal('read'), path: relativePath,
    offsetBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
    maxBytes: bytes.default(MCP_LIMITS.outputBytes), }).strict(), write,
]);
export const MCP_TOOLS = {
  session_create: { description: 'Create an isolated reusable workspace. Retry only with the same requestId and payload.',
    schema: z.object({ requestId, tenantId: id, projectId: id,
      profile: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/).optional(),
      ttlSeconds: z.number().int().min(60).max(MCP_LIMITS.idleSeconds).default(MCP_LIMITS.idleSeconds), }).strict(), },
  session_get: { description: 'Inspect a workspace and supported capabilities.', schema: z.object(sessionId).strict(), readOnly: true },
  session_delete: { description: 'Delete an idle workspace. Cancel active jobs first.', schema: z.object(sessionId).strict() },
  bash_exec: { description: 'Submit bash -lc inside a sandbox workspace and return a jobId immediately. Use job_get to poll; job_cancel to cancel.',
    schema: z.object({ ...sessionId, command: z.string().min(1).max(65536).refine(s => Buffer.byteLength(s) <= 65536, 'Command is too large'), cwd: relativePath.default('.'),
      timeoutSeconds: z.number().int().min(1).max(MCP_LIMITS.maxTimeoutSeconds).default(MCP_LIMITS.timeoutSeconds), requestId }).strict() },
  job_get: { description: 'Poll job status, exit code, bounded output and authorized artifact references.',
    schema: z.object({ jobId: id, cursor: z.string().regex(/^\d+:\d+$/).max(100).default('0:0'),
      maxOutputBytes: bytes.default(MCP_LIMITS.outputBytes) }).strict(), readOnly: true },
  job_cancel: { description: 'Explicitly request cancellation of a sandbox job; transport disconnect does not cancel accepted jobs.',
    schema: z.object({ jobId: id, reason: z.string().min(1).max(256).default('client requested cancellation') }).strict() },
  file_ops: { description: 'List/read UTF-8 files or conditionally write one file. Paths are relative to the sandbox workspace. Write requires createOnly=true or expectedHash.', schema: fileOps },
};
export function listMcpTools() {
  return Object.entries(MCP_TOOLS).map(([name, tool]) => ({ name, description: tool.description,
    inputSchema: toolInputSchema(name, tool),
    annotations: { readOnlyHint: Boolean(tool.readOnly), destructiveHint: !tool.readOnly, openWorldHint: name === 'bash_exec' },
  }));
}
export function parseMcpArguments(name, value) {
  const tool = Object.hasOwn(MCP_TOOLS, name) ? MCP_TOOLS[name] : null;
  if (!tool) throw Object.assign(new Error('Unknown tool'), { code: 'INVALID_ARGUMENT' });
  const parsed = tool.schema.safeParse(value);
  if (!parsed.success) throw Object.assign(new Error('Invalid tool arguments'), { code: 'INVALID_ARGUMENT' });
  return parsed.data;
}

function toolInputSchema(name, tool) {
  const schema = { ...zodToJsonSchema(tool.schema, { $refStrategy: 'none' }), type: 'object' };
  if (name === 'file_ops') schema.anyOf[2].oneOf = [
    { required: ['createOnly'], properties: { createOnly: { const: true } }, not: { required: ['expectedHash'] } },
    { required: ['expectedHash'], properties: { createOnly: { const: false } } },
  ];
  return schema;
}
