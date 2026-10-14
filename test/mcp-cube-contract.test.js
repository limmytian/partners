import test from 'node:test';
import assert from 'node:assert/strict';
import { CubeSandboxProvider } from '../src/providers/cubesandbox-provider.js';
import { fixture } from './helpers/mcp-fixture.js';
const headers = { authorization: 'Bearer full' };

test('remote Cube adapter preserves logical IDs and fences cancellation by destroying runtime', async t => {
  let deleted = 0, executing = false;
  const client = {
    async createSandbox() { return { id: 'remote-assigned-id', createdAt: new Date().toISOString() }; },
    async exec(id, request, options) {
      assert.equal(id, 'remote-assigned-id'); executing = true;
      return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    },
    async deleteSandbox(id) { assert.equal(id, 'remote-assigned-id'); deleted++; },
  };
  const provider = new CubeSandboxProvider({ client, mode: 'remote' });
  const f = await fixture(t, { gateway: { provider } });
  const session = await f.service.call('session_create', { tenantId: 't', projectId: 'p', requestId: 'create-001' }, headers);
  assert.notEqual(session.sessionId, 'remote-assigned-id');
  const accepted = await f.service.call('bash_exec', { sessionId: session.sessionId, command: 'sleep 20', requestId: 'exec-0001' }, headers);
  const completion = f.service.running.get(accepted.jobId);
  for (let n = 0; n < 50 && !executing; n++) await new Promise(r => setTimeout(r, 10));
  await f.service.call('job_cancel', { jobId: accepted.jobId }, headers); await completion;
  assert.equal(deleted, 1);
  assert.equal((await f.gateway.getJob(accepted.jobId)).state, 'cancelled');
  assert.equal((await f.gateway.store.getSession(session.sessionId)).state, 'deleted');
  await assert.rejects(f.service.call('bash_exec', { sessionId: session.sessionId, command: 'true', requestId: 'exec-0002' }, headers), { code: 'SESSION_EXPIRED' });
});

test('remote file adapter uses fixed isolated Python inside sandbox and forwards policy errors', async () => {
  const provider = new CubeSandboxProvider({ mode: 'remote', client: {
    async exec(id, request) {
      assert.equal(id, 'remote-id');
      assert.deepEqual(request.argv.slice(0, 3), ['python3', '-I', '-c']);
      assert.equal(request.argv[4], '/workspace');
      assert.equal(request.cwd, '/workspace');
      return { exitCode: 0, stdout: JSON.stringify({ ok: false, code: 'FORBIDDEN' }) };
    },
  } });
  provider.restoreSession({ id: 'logical-id', providerSessionId: 'remote-id' });
  await assert.rejects(provider.mcpFileOperation('logical-id', { action: 'read', path: '.env' }), { code: 'FORBIDDEN' });
});
