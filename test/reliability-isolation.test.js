import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalSandboxProvider, InMemoryAgentExecutionGateway, GatewayServiceAuthorizer, createAgentExecutionGatewayServer } from '../src/index.js';

test('scoped snapshots/templates filter before pagination and reject foreign derivation without provider effects', async t => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'partners-isolation-'));
  const provider = new LocalSandboxProvider({ rootDir });
  const gateway = new InMemoryAgentExecutionGateway({ provider });
  const authorizer = new GatewayServiceAuthorizer({ tokens: [
    { token: 'a', scopes: ['*'], tenantIds: ['a'], projectIds: ['p'] },
    { token: 'multi', scopes: ['*'], tenantIds: ['a','b'], projectIds: ['p','q'] },
  ] });
  const app = createAgentExecutionGatewayServer({ gateway, authorizer, logger: {} });
  await new Promise(r => app.listen(0, '127.0.0.1', r));
  t.after(async () => { await app.close(); await rm(rootDir, { recursive: true, force: true }); });
  const call = async (url, body, token = 'a') => {
    const r = await fetch(`http://127.0.0.1:${app.server.address().port}/v1/${url}`, { method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: await r.json() };
  };
  const resources = [];
  for (const [tenantId, projectId] of [['a','p'],['b','p'],['a','q']]) {
    const session = await gateway.createSession({ tenantId, projectId });
    await provider.syncWorkspaceFiles(session.id, [{ path: 'owner.txt', content: `${tenantId}/${projectId}` }]);
    const snapshot = await gateway.createSessionSnapshot(session.id);
    const template = await gateway.createTemplate({ name: 'source', snapshotId: snapshot.id, tenantId, projectId });
    resources.push({ session, snapshot, template });
  }
  // admin:* remains intersected with credential bounds.
  assert.equal((await call('admin/overview')).body.sessions.total, 1);
  assert.deepEqual((await call('admin/sessions?limit=1&offset=1')).body.items, []);
  assert.equal((await call('admin/sessions?tenantId=b')).status, 403);
  assert.equal((await call(`admin/sessions/${resources[1].session.id}/stop`, {})).status, 403);
  await gateway.store.saveJob({ id: 'foreign-job', tenantId: 'b', projectId: 'p', state: 'running' });
  assert.equal((await call('admin/jobs/foreign-job/cancel', {})).status, 403);
  assert.deepEqual((await call('admin/jobs')).body.items, []);
  let creates = 0, runs = 0;
  const create = provider.createSession.bind(provider), run = provider.runJob.bind(provider);
  provider.createSession = (...a) => { creates++; return create(...a); };
  provider.runJob = (...a) => { runs++; return run(...a); };
  for (const kind of ['snapshots','templates']) {
    const list = await call(`${kind}?limit=1&offset=0`);
    assert.equal(list.status, 200); assert.equal(list.body.items.length, 1);
    assert.equal(list.body.items[0].tenantId, 'a'); assert.equal(list.body.items[0].projectId, 'p');
    assert.deepEqual((await call(`${kind}?limit=1&offset=1`)).body.items, []);
    assert.equal((await call(`${kind}?tenantId=b`)).status, 403);
    assert.equal((await call(`${kind}?projectId=q`)).status, 403);
  }
  for (const foreign of resources.slice(1)) {
    assert.equal((await call('sessions', { id: foreign.session.id })).status, 409);
    assert.equal((await call(`snapshots/${foreign.snapshot.id}`)).status, 403);
    assert.equal((await call(`templates/${foreign.template.id}`)).status, 403);
    for (const scope of [{}, { tenantId: 'a', projectId: 'p' }]) {
      assert.equal((await call('sessions', { ...scope, templateId: foreign.template.id })).status, 403);
      assert.equal((await call('sessions', { ...scope, snapshotId: foreign.snapshot.id })).status, 403);
      assert.equal((await call('templates', { ...scope, snapshotId: foreign.snapshot.id, name: 'stolen' })).status, 403);
    }
    assert.equal((await call(`sessions/${foreign.session.id}/snapshots`, { tenantId: 'a', projectId: 'p' })).status, 403);
    assert.equal((await call('jobs', { tenantId: 'a', projectId: 'p', sessionId: foreign.session.id,
      executionMode: 'workspace_session', command: { argv: ['sh','-c','true'] }, timeoutSeconds: 10 })).status, 403);
  }
  assert.equal((await call('jobs', { id: 'foreign-job', executionMode: 'ephemeral_interpreter',
    command: { argv: ['true'] }, timeoutSeconds: 10 })).status, 409);
  provider.getSnapshot = async () => ({ id: 'provider-only', snapshotPath: '/private' });
  assert.equal((await call('snapshots/provider-only')).status, 404);
  assert.equal((await call('sessions', { snapshotId: 'provider-only' })).status, 403);
  assert.equal((await call('sessions', { templateId: resources[0].template.id }, 'multi')).status, 400);
  assert.equal(creates, 0); assert.equal(runs, 0);
  const good = await call('sessions', { templateId: resources[0].template.id });
  assert.equal(good.status, 202);
  assert.equal((await provider.readWorkspaceFile(good.body.id, 'owner.txt')).content, 'a/p');
});
