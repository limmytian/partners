import assert from 'node:assert/strict';
import test from 'node:test';

import { CubeSandboxClient } from '../src/providers/cubesandbox-client.js';
import { createCubeSandboxMockServer } from './helpers/cubesandbox-mock-server.js';

test('CubeSandboxClient: healthCheck and getInfo', async () => {
  const mockServer = await createCubeSandboxMockServer();
  try {
    const client = new CubeSandboxClient({ endpoint: mockServer.url });

    const health = await client.healthCheck();
    assert.equal(health.healthy, true);
    assert.equal(health.status, 'ok');
    assert.equal(health.kernel, '6.6.30-cube-microvm');

    const info = await client.getInfo();
    assert.equal(info.kvm, true);
    assert.ok(Array.isArray(info.capabilities));

    // Test health failure on dead port
    const deadClient = new CubeSandboxClient({ endpoint: 'http://127.0.0.1:59999', timeoutMs: 500 });
    const deadHealth = await deadClient.healthCheck();
    assert.equal(deadHealth.healthy, false);
    assert.equal(deadHealth.status, 'unhealthy');
  } finally {
    await mockServer.close();
  }
});

test('CubeSandboxClient: authorization header with API key', async () => {
  const validKey = 'cube-secret-key-123';
  const mockServer = await createCubeSandboxMockServer({ apiKey: validKey });
  try {
    // 1. Without key should fail 401
    const unauthedClient = new CubeSandboxClient({ endpoint: mockServer.url });
    await assert.rejects(
      async () => unauthedClient.getInfo(),
      /Unauthorized/
    );

    // 2. With valid key should succeed
    const authedClient = new CubeSandboxClient({ endpoint: mockServer.url, apiKey: validKey });
    const info = await authedClient.getInfo();
    assert.equal(info.version, '0.1.0-cube');
  } finally {
    await mockServer.close();
  }
});

test('CubeSandboxClient: sandbox lifecycle and command execution', async () => {
  const mockServer = await createCubeSandboxMockServer();
  try {
    const client = new CubeSandboxClient({ endpoint: mockServer.url });

    // Create sandbox
    const sb = await client.createSandbox({
      id: 'test_sb_1',
      resources: { vCpu: 2, memoryMib: 1024 },
    });
    assert.equal(sb.id, 'test_sb_1');
    assert.equal(sb.status, 'ready');
    assert.equal(sb.microVm.isolation, 'hardware_virtualization_kvm');

    // Get sandbox
    const fetched = await client.getSandbox('test_sb_1');
    assert.equal(fetched.id, 'test_sb_1');

    // Exec
    const execResult = await client.exec('test_sb_1', {
      argv: ['python3', '-c', 'print("hello microvm")'],
    });
    assert.equal(execResult.exitCode, 0);
    assert.ok(execResult.stdout.includes('python3'));

    // Cancel
    const cancelResult = await client.cancelExec('test_sb_1');
    assert.equal(cancelResult.cancelled, true);

    // Delete sandbox
    const del = await client.deleteSandbox('test_sb_1');
    assert.equal(del.deleted, true);

    await assert.rejects(
      async () => client.getSandbox('test_sb_1'),
      /not found/i
    );
  } finally {
    await mockServer.close();
  }
});

test('CubeSandboxClient: snapshots, instant fork, and file operations', async () => {
  const mockServer = await createCubeSandboxMockServer();
  try {
    const client = new CubeSandboxClient({ endpoint: mockServer.url });
    const sb = await client.createSandbox({ id: 'parent_sb' });

    // Snapshot
    const snap = await client.createSnapshot('parent_sb', { label: 'checkpoint_a' });
    assert.ok(snap.id.startsWith('cube_snap_'));
    assert.equal(snap.label, 'checkpoint_a');

    const snapDetails = await client.getSnapshot(snap.id);
    assert.equal(snapDetails.id, snap.id);

    // Fork
    const forked = await client.forkFromSnapshot(snap.id, { id: 'forked_sb' });
    assert.equal(forked.id, 'forked_sb');
    assert.equal(forked.microVm.forkedFrom, snap.id);

    // File tree & read
    const tree = await client.listWorkspaceTree('parent_sb');
    assert.ok(tree.files.length >= 2);

    const file = await client.readWorkspaceFile('parent_sb', 'hello.txt');
    assert.equal(file.content, 'hello from microvm');

    // Sync files
    const syncRes = await client.syncWorkspaceFiles('parent_sb', [
      { path: 'test.py', content: 'print(1)' },
    ]);
    assert.equal(syncRes.synced, true);

    // Archive download & extract
    const archiveBuf = await client.downloadWorkspaceArchive('parent_sb');
    assert.ok(Buffer.isBuffer(archiveBuf));
    assert.equal(archiveBuf.toString(), 'FAKE_TAR_GZ_BYTES');

    const extractRes = await client.extractWorkspaceArchive('parent_sb', archiveBuf);
    assert.equal(extractRes.extracted, true);

    // Pty URL
    const ptyUrl = client.getPtyUrl('parent_sb', { cols: 100, rows: 30 });
    assert.ok(ptyUrl.startsWith('ws://127.0.0.1'));
    assert.ok(ptyUrl.includes('/v1/sandboxes/parent_sb/pty'));
    assert.ok(ptyUrl.includes('cols=100'));
  } finally {
    await mockServer.close();
  }
});

test('CubeSandbox exec never retries a lost response or permission failure through another endpoint', async () => {
  for (const failure of ['network', 'unauthorized']) {
    let calls = 0;
    const client = new CubeSandboxClient({ endpoint: 'http://cube.test', fetchImpl: async () => {
      calls++;
      if (failure === 'network') throw new Error('lost response');
      return new Response('{}', { status: 403 });
    } });
    await assert.rejects(client.exec('sandbox', { argv: ['bash', '-lc', 'true'] }));
    assert.equal(calls, 1);
  }
});

test('envd byte frames preserve UTF-8 across independent stdout and stderr boundaries', async () => {
  const stdout = Buffer.from('你好世界\n'), stderr = Buffer.from('错误消息\n');
  const frame = event => { const body = Buffer.from(JSON.stringify({ event })); const header = Buffer.alloc(5); header.writeUInt32BE(body.length, 1); return Buffer.concat([header, body]); };
  const body = Buffer.concat([
    frame({ data: { stdout: stdout.subarray(0, 2).toString('base64'), stderr: stderr.subarray(0, 1).toString('base64') } }),
    frame({ data: { stdout: stdout.subarray(2).toString('base64'), stderr: stderr.subarray(1).toString('base64') } }),
    frame({ end: { exitCode: 7, exited: true } }),
  ]);
  let calls = 0; const chunks = [];
  const client = new CubeSandboxClient({ endpoint: 'http://cube.test', fetchImpl: async () => ++calls === 1 ? new Response('{}', { status: 404 }) : new Response(body) });
  const result = await client.exec('sandbox', { argv: ['true'] }, { onChunk: chunk => chunks.push(chunk) });
  assert.equal(result.stdout, '你好世界\n'); assert.equal(result.stderr, '错误消息\n'); assert.equal(result.exitCode, 7);
  assert.equal(chunks.filter(c => c.type === 'stdout').map(c => c.data).join(''), result.stdout);
  assert.equal(chunks.filter(c => c.type === 'stderr').map(c => c.data).join(''), result.stderr);
});

test('envd streams output before completion and tolerates fragmented frame headers', async () => {
  const frame = event => { const body = Buffer.from(JSON.stringify({ event })); const header = Buffer.alloc(5); header.writeUInt32BE(body.length, 1); return Buffer.concat([header, body]); };
  let stream, signalChunk;
  const received = new Promise(resolve => { signalChunk = resolve; });
  const body = new ReadableStream({ start(controller) { stream = controller; } });
  let calls = 0, finished = false;
  const client = new CubeSandboxClient({ endpoint: 'http://cube.test', fetchImpl: async () => ++calls === 1 ? new Response('{}', { status: 404 }) : new Response(body) });
  const pending = client.exec('sandbox', { argv: ['true'] }, { onChunk: signalChunk }).then(result => { finished = true; return result; });
  const first = frame({ data: { stdout: Buffer.from('started\n').toString('base64') } });
  stream.enqueue(first.subarray(0, 3)); stream.enqueue(first.subarray(3));
  assert.deepEqual(await received, { type: 'stdout', data: 'started\n' }); assert.equal(finished, false);
  stream.enqueue(frame({ end: { exitCode: 0, exited: true } })); stream.close();
  assert.equal((await pending).stdout, 'started\n');
});
