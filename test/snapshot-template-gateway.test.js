import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { LocalSandboxProvider } from '../src/providers/local-sandbox-provider.js';
import { CubeSandboxProvider } from '../src/providers/cubesandbox-provider.js';
import { InMemoryAgentExecutionGateway } from '../src/gateway/in-memory-agent-execution-gateway.js';
import { createAgentExecutionGatewayServer } from '../src/gateway/http-agent-execution-gateway.js';

test('Snapshot & Template API: LocalSandboxProvider creates snapshots and provisions restored sessions', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'partners-snap-test-'));
  const provider = new LocalSandboxProvider({ rootDir });

  try {
    const session1 = await provider.createSession({ id: 's1' });
    await provider.syncWorkspaceFiles('s1', [
      { path: 'app.js', content: 'console.log("snapshot v1");' },
      { path: 'config.json', content: '{"version": 1}' },
    ]);

    const snapshot = await provider.createSnapshot('s1', { label: 'v1.0.0' });
    assert.ok(snapshot.id.startsWith('snap_'));
    assert.equal(snapshot.label, 'v1.0.0');

    // Create a new session restored from snapshot
    const session2 = await provider.createSession({ id: 's2', snapshotId: snapshot.id });
    assert.equal(session2.snapshotId, snapshot.id);

    const appFile = await provider.readWorkspaceFile('s2', 'app.js');
    assert.equal(appFile.content, 'console.log("snapshot v1");');

    const cfgFile = await provider.readWorkspaceFile('s2', 'config.json');
    assert.equal(cfgFile.content, '{"version": 1}');
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('Snapshot & Template API: HTTP gateway snapshot, template lifecycle and session restoration', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'partners-snap-http-'));
  const provider = new LocalSandboxProvider({ rootDir });
  const gateway = new InMemoryAgentExecutionGateway({ provider });
  const app = createAgentExecutionGatewayServer({ gateway });

  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Create a session
    const resCreate = await fetch(`${baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(resCreate.status, 202);
    const session = await resCreate.json();

    // 2. Put some files into the session
    await provider.syncWorkspaceFiles(session.id, [
      { path: 'hello.txt', content: 'world from template' },
    ]);

    // 3. Create a snapshot from the session
    const resSnap = await fetch(`${baseUrl}/v1/sessions/${session.id}/snapshots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'base-env', metadata: { author: 'task-weaver' } }),
    });
    assert.equal(resSnap.status, 201);
    const snap = await resSnap.json();
    assert.ok(snap.id);
    assert.equal(snap.label, 'base-env');

    // 4. Query snapshot
    const resGetSnap = await fetch(`${baseUrl}/v1/snapshots/${snap.id}`);
    assert.equal(resGetSnap.status, 200);
    const snapDetails = await resGetSnap.json();
    assert.equal(snapDetails.id, snap.id);

    const resListSnap = await fetch(`${baseUrl}/v1/snapshots`);
    assert.equal(resListSnap.status, 200);
    const snapList = await resListSnap.json();
    assert.equal(snapList.items.length, 1);
    assert.equal(snapList.items[0].id, snap.id);

    // 5. Create a template pointing to the snapshot
    const resTpl = await fetch(`${baseUrl}/v1/templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'python-datascience',
        snapshotId: snap.id,
        description: 'Preconfigured Python DS template',
      }),
    });
    assert.equal(resTpl.status, 201);
    const tpl = await resTpl.json();
    assert.ok(tpl.id.startsWith('tpl_'));
    assert.equal(tpl.name, 'python-datascience');
    assert.equal(tpl.snapshotId, snap.id);

    // 6. List and get templates
    const resListTpl = await fetch(`${baseUrl}/v1/templates`);
    assert.equal(resListTpl.status, 200);
    const tplList = await resListTpl.json();
    assert.equal(tplList.items.length, 1);
    assert.equal(tplList.items[0].id, tpl.id);

    const resGetTpl = await fetch(`${baseUrl}/v1/templates/${tpl.id}`);
    assert.equal(resGetTpl.status, 200);
    const tplDetails = await resGetTpl.json();
    assert.equal(tplDetails.id, tpl.id);

    // 7. Spawn a new session using templateId
    const resSpawnTpl = await fetch(`${baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ templateId: tpl.id }),
    });
    assert.equal(resSpawnTpl.status, 202);
    const spawnedSession = await resSpawnTpl.json();
    assert.equal(spawnedSession.templateId, tpl.id);
    assert.equal(spawnedSession.snapshotId, snap.id);

    // Verify workspace was cloned with template content
    const spawnedFile = await provider.readWorkspaceFile(spawnedSession.id, 'hello.txt');
    assert.equal(spawnedFile.content, 'world from template');

    // 8. Spawn a session directly using snapshotId
    const resSpawnSnap = await fetch(`${baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshotId: snap.id }),
    });
    assert.equal(resSpawnSnap.status, 202);
    const spawnedSnapSession = await resSpawnSnap.json();
    assert.equal(spawnedSnapSession.snapshotId, snap.id);
    const spawnedSnapFile = await provider.readWorkspaceFile(spawnedSnapSession.id, 'hello.txt');
    assert.equal(spawnedSnapFile.content, 'world from template');
  } finally {
    await app.close();
    await rm(rootDir, { recursive: true, force: true });
  }
});
