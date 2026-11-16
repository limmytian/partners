import test from 'node:test';
import assert from 'node:assert/strict';
import { CubeSandboxClient } from '../src/providers/cubesandbox-client.js';
import { CubeSandboxProvider } from '../src/providers/cubesandbox-provider.js';

test('unsupported remote snapshot/fork cannot manufacture success or provision an empty replacement', async () => {
  const paths = [];
  const client = new CubeSandboxClient({ endpoint: 'http://cube.test', fetchImpl: async url => {
    paths.push(new URL(url).pathname); return new Response('{}', { status: 404 });
  } });
  await assert.rejects(client.createSnapshot('runtime'));
  await assert.rejects(client.forkFromSnapshot('snapshot'));
  await assert.rejects(client.createSandbox({ snapshotId: 'snapshot' }), { code: 'UNSUPPORTED_CAPABILITY' });
  assert.equal(paths.filter(p => p === '/sandboxes').length, 0);
  assert.equal((await client.getInfo()).version, null);
});

test('remote lifecycle permission errors never trigger alternate endpoint calls', async () => {
  let calls = 0;
  const client = new CubeSandboxClient({ endpoint: 'http://cube.test', fetchImpl: async () => { calls++; return new Response('{}', { status: 403 }); } });
  for (const action of [() => client.getSandbox('s'), () => client.deleteSandbox('s'), () => client.listSandboxes()]) {
    const before = calls; await assert.rejects(action); assert.equal(calls, before + 1);
  }
});

test('remote file delegations use provider ID and report unverified runtime facts', async () => {
  const seen = [];
  const client = { async createSandbox() { return { id: 'physical' }; },
    async listWorkspaceTree(id) { seen.push(id); }, async readWorkspaceFile(id) { seen.push(id); return { content: '' }; },
    async syncWorkspaceFiles(id) { seen.push(id); } };
  const provider = new CubeSandboxProvider({ mode: 'remote', client });
  const session = await provider.createSession({ id: 'logical' });
  assert.equal(session.microVm.kernelVersion, null); assert.equal(session.microVm.isolation, 'unverified');
  await provider.listWorkspaceTree(session.id); await provider.readWorkspaceFile(session.id, 'f'); await provider.syncWorkspaceFiles(session.id, []);
  assert.deepEqual(seen, ['physical','physical','physical']);
  assert.equal(provider.supports('terminal.pty'), false);
  assert.equal(provider.supports('cube_cow.memory_snapshot'), false);
  assert.equal(provider.supports('microvm.sub_60ms_start'), false);
});
