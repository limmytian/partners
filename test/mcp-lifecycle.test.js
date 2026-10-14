import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/mcp-fixture.js';
const headers = { authorization: 'Bearer full' };
async function create(f, requestId = 'create-001') { return f.service.call('session_create', { tenantId: 't', projectId: 'p', requestId }, headers); }

test('HTTP file/exec loop, mixed permissions, safe pagination and idempotent writes', async t => {
  const f = await fixture(t), c = await f.client(), s = await create(f);
  const write = { sessionId: s.sessionId, action: 'write', path: 'hello.py', content: "print('你好 MCP')", createOnly: true, requestId: 'write-001' };
  const first = await c.callTool({ name: 'file_ops', arguments: write }); assert.equal(first.isError, undefined);
  assert.equal((await c.callTool({ name: 'file_ops', arguments: write })).structuredContent.hash, first.structuredContent.hash);
  const accepted = await f.service.call('bash_exec', { sessionId: s.sessionId, command: 'python3 hello.py', requestId: 'exec-0001' }, headers);
  await f.service.running.get(accepted.jobId);
  let cursor, text = '', page;
  do {
    page = await f.service.call('job_get', { jobId: accepted.jobId, maxOutputBytes: 4, ...(cursor ? { cursor } : {}) }, headers);
    text += page.stdout; assert.ok(Buffer.byteLength(page.stdout + page.stderr) <= 4); cursor = page.nextCursor;
  } while (page.truncated);
  assert.equal(text, '你好 MCP\n');
  const reader = await f.client('read');
  assert.equal((await reader.callTool({ name: 'file_ops', arguments: { sessionId: s.sessionId, action: 'read', path: 'hello.py' } })).isError, undefined);
  assert.equal((await reader.callTool({ name: 'file_ops', arguments: { ...write, requestId: 'write-002' } })).structuredContent.code, 'FORBIDDEN');
  const rest = await fetch(new URL('/v1/jobs', f.url), { method: 'POST', headers: { authorization: 'Bearer full', 'content-type': 'application/json' },
    body: JSON.stringify({ executionMode: 'workspace_session', tenantId: 't', projectId: 'p', sessionId: s.sessionId, command: { argv: ['bash', '-lc', 'true'] }, timeoutSeconds: 10 }) });
  assert.equal(rest.status, 409);
});

test('single writer blocks concurrent operations and cancellation kills descendants', { timeout: 7000 }, async t => {
  const f = await fixture(t), s = await create(f);
  const accepted = await f.service.call('bash_exec', { sessionId: s.sessionId, command: 'trap "" TERM; printf ready; sleep 20', requestId: 'exec-busy' }, headers);
  const completion = f.service.running.get(accepted.jobId);
  for (let n = 0; n < 50 && !(await f.gateway.listJobEvents(accepted.jobId)).some(e => e.chunk === 'ready'); n++) await new Promise(r => setTimeout(r, 10));
  await assert.rejects(f.service.call('bash_exec', { sessionId: s.sessionId, command: 'true', requestId: 'exec-next' }, headers), { code: 'SESSION_BUSY' });
  await assert.rejects(f.service.call('file_ops', { sessionId: s.sessionId, action: 'write', path: 'x', content: 'x', createOnly: true, requestId: 'write-001' }, headers), { code: 'SESSION_BUSY' });
  await f.service.call('job_cancel', { jobId: accepted.jobId }, headers); await completion;
  assert.equal((await f.gateway.getJob(accepted.jobId)).state, 'cancelled');
  const retry = await f.service.call('bash_exec', { sessionId: s.sessionId, command: 'true', requestId: 'exec-next' }, headers);
  await f.service.running.get(retry.jobId);
  assert.equal((await f.gateway.getJob(retry.jobId)).state, 'succeeded');
  await f.service.call('session_delete', { sessionId: s.sessionId }, headers);
});

test('timeout and idle TTL reclaim workspace without deleting job history', { timeout: 5000 }, async t => {
  let now = Date.now(); const f = await fixture(t, { service: { clock: () => now } }), s = await create(f);
  const accepted = await f.service.call('bash_exec', { sessionId: s.sessionId, command: 'sleep 20', timeoutSeconds: 1, requestId: 'exec-time' }, headers);
  await f.service.running.get(accepted.jobId);
  assert.equal((await f.gateway.getJob(accepted.jobId)).state, 'timed_out');
  now += 1801000; await f.service.sweep();
  assert.equal((await f.gateway.store.getSession(s.sessionId)).state, 'deleted');
  assert.ok(await f.gateway.getJob(accepted.jobId));
});

test('stale worker becomes explicit unknown execution and quarantines workspace', async t => {
  let now = Date.now(); const f = await fixture(t, { service: { clock: () => now } }), s = await create(f);
  const jobId = 'job_interrupted';
  await f.gateway.store.saveJob({ id: jobId, sessionId: s.sessionId, state: 'running', tenantId: 't', projectId: 'p', metadata: { mcp: true } });
  await f.service.coordinator.claim('lock:' + s.sessionId, '', { state: 'job', jobId, createdAt: now - 46000, heartbeatAt: now - 46000 });
  const result = await f.service.call('job_get', { jobId }, headers);
  assert.equal(result.terminalReason, 'EXECUTION_UNKNOWN');
  await assert.rejects(f.service.call('bash_exec', { sessionId: s.sessionId, command: 'true', requestId: 'exec-new1' }, headers), { code: 'RECOVERY_REQUIRED' });
  await f.service.call('session_delete', { sessionId: s.sessionId }, headers);
  assert.equal(await f.service.coordinator.get('lock:' + s.sessionId), null);
});

test('reaper fences an expired quarantined workspace and releases its stale writer', async t => {
  let now = Date.now(); const f = await fixture(t, { service: { clock: () => now } }), s = await create(f);
  const jobId = 'job_expired_worker';
  await f.gateway.store.saveJob({ id: jobId, sessionId: s.sessionId, state: 'running', tenantId: 't', projectId: 'p', metadata: { mcp: true } });
  await f.service.coordinator.claim('lock:' + s.sessionId, '', { state: 'job', jobId, createdAt: now, heartbeatAt: now });
  now += 28801000; await f.service.sweep();
  assert.equal((await f.gateway.store.getSession(s.sessionId)).state, 'deleted');
  assert.equal((await f.gateway.store.getJob(jobId)).metadata.mcpRecovery, true);
  assert.equal(await f.service.coordinator.get('lock:' + s.sessionId), null);
});
