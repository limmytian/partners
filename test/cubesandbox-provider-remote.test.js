import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CubeSandboxProvider,
  ExecutionMode,
  InMemoryAgentExecutionGateway,
  JobState,
  createAgentExecutionGatewayServer,
} from '../src/index.js';
import { createCubeSandboxMockServer } from './helpers/cubesandbox-mock-server.js';

test('CubeSandboxProvider (Remote): healthCheck, reconcile and session lifecycle over HTTP', async () => {
  const mockServer = await createCubeSandboxMockServer();
  try {
    const provider = new CubeSandboxProvider({
      endpoint: mockServer.url,
      mode: 'remote',
    });

    // 1. Health check & reconcile
    const health = await provider.healthCheck();
    assert.equal(health.healthy, true);

    const rec = await provider.reconcile();
    assert.equal(rec.reconciled, true);
    assert.equal(rec.mode, 'remote');

    // 2. Create Session
    const session = await provider.createSession({
      id: 'cube_test_session_1',
      resources: { vCpu: 2, memoryMib: 1024 },
    });
    assert.equal(session.id, 'cube_test_session_1');
    assert.equal(session.provider, 'cubesandbox');
    assert.equal(session.remote, true);
    assert.equal(session.microVm.isolation, 'hardware_virtualization_kvm');
    assert.equal(session.microVm.kernelVersion, '6.6.30-cube-microvm');

    // 3. Get Session
    const fetched = await provider.getSession('cube_test_session_1');
    assert.equal(fetched.id, 'cube_test_session_1');

    // 4. Delete Session
    const deleted = await provider.deleteSession('cube_test_session_1');
    assert.equal(deleted.state, 'deleted');
  } finally {
    await mockServer.close();
  }
});

test('CubeSandboxProvider (Remote): runJob with event stream over HTTP', async () => {
  const mockServer = await createCubeSandboxMockServer();
  try {
    const provider = new CubeSandboxProvider({
      endpoint: mockServer.url,
      mode: 'remote',
    });

    const session = await provider.createSession({ id: 'cube_exec_ses' });
    const events = [];

    const result = await provider.runJob({
      executionMode: ExecutionMode.WorkspaceSession,
      sessionId: session.id,
      command: { argv: ['echo', 'hello remote microvm'] },
      inputs: {
        files: [{ path: 'main.py', content: 'print(42)' }],
      },
      timeoutSeconds: 30,
    }, (ev) => events.push(ev));

    assert.equal(result.state, JobState.Succeeded);
    assert.equal(result.provider, 'cubesandbox');
    assert.equal(result.microVm.coldStartSub60ms, true);
    assert.ok(events.some((e) => e.type === 'microvm.ready'));
    assert.ok(events.some((e) => e.type === 'job.state'));

    await provider.deleteSession(session.id);
  } finally {
    await mockServer.close();
  }
});

test('CubeSandboxProvider (Remote): snapshots and instant fork over HTTP', async () => {
  const mockServer = await createCubeSandboxMockServer();
  try {
    const provider = new CubeSandboxProvider({
      endpoint: mockServer.url,
      mode: 'remote',
    });

    const session = await provider.createSession({ id: 'cube_parent_ses' });

    // Snapshot
    const snap = await provider.createSnapshot(session.id, { label: 'checkpoint_v1' });
    assert.ok(snap.id.startsWith('cube_snap_'));
    assert.equal(snap.label, 'checkpoint_v1');

    // Fork
    const forked = await provider.forkFromSnapshot(snap.id, { id: 'cube_forked_ses' });
    assert.equal(forked.id, 'cube_forked_ses');
    assert.equal(forked.provider, 'cubesandbox');
    assert.equal(forked.remote, true);
    assert.equal(forked.microVm.forkedFrom, snap.id);

    await provider.deleteSession(session.id);
    await provider.deleteSession(forked.id);
  } finally {
    await mockServer.close();
  }
});

test('CubeSandboxProvider (Remote): workspace file operations and PTY session over HTTP', async () => {
  const mockServer = await createCubeSandboxMockServer();
  try {
    const provider = new CubeSandboxProvider({
      endpoint: mockServer.url,
      mode: 'remote',
    });

    const session = await provider.createSession({ id: 'cube_files_ses' });

    // File tree
    const tree = await provider.listWorkspaceTree(session.id);
    assert.ok(tree.files.length >= 2);

    // Read file
    const file = await provider.readWorkspaceFile(session.id, 'config.json');
    assert.equal(file.content, 'hello from microvm');

    // Sync files
    const syncRes = await provider.syncWorkspaceFiles(session.id, [
      { path: 'test.js', content: 'console.log(1);' },
    ]);
    assert.equal(syncRes.synced, true);

    // Archive download stream
    const archiveStream = await provider.downloadWorkspaceArchive(session.id);
    const chunks = [];
    for await (const chunk of archiveStream) {
      chunks.push(chunk);
    }
    const archiveBuf = Buffer.concat(chunks);
    assert.equal(archiveBuf.toString(), 'FAKE_TAR_GZ_BYTES');

    // Archive extract
    const extractRes = await provider.extractWorkspaceArchive(session.id, archiveBuf);
    assert.equal(extractRes.extracted, true);

    // PTY session
    const pty = await provider.createPtySession(session.id, { cols: 100, rows: 40 });
    assert.ok(pty);
    assert.equal(pty.cols, 100);
    assert.equal(pty.rows, 40);

    let ptyClosed = false;
    pty.on('close', () => { ptyClosed = true; });
    pty.kill();
    assert.equal(ptyClosed, true);

    await provider.deleteSession(session.id);
  } finally {
    await mockServer.close();
  }
});

test('CubeSandboxProvider (Remote): Gateway integration without caller code modifications', async () => {
  const mockServer = await createCubeSandboxMockServer();
  try {
    const provider = new CubeSandboxProvider({
      endpoint: mockServer.url,
      mode: 'remote',
    });

    const gateway = new InMemoryAgentExecutionGateway({ provider });
    const app = createAgentExecutionGatewayServer({ gateway });

    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const port = app.server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // 1. Caller creates session via standard POST /v1/sessions
      const resCreate = await fetch(`${baseUrl}/v1/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resources: { vCpu: 2, memoryMib: 1024 },
        }),
      });
      assert.equal(resCreate.status, 202);
      const session = await resCreate.json();
      assert.ok(session.id);
      assert.equal(session.provider, 'cubesandbox');

      // 2. Caller submits job via standard POST /v1/jobs
      const resJob = await fetch(`${baseUrl}/v1/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          executionMode: 'workspace_session',
          sessionId: session.id,
          command: { argv: ['python3', '-c', 'print("gateway calling microvm")'] },
          timeoutSeconds: 30,
        }),
      });
      assert.equal(resJob.status, 202);
      const job = await resJob.json();
      assert.ok(job.id);

      // 3. Wait for job completion
      let status = job.state;
      for (let i = 0; i < 20; i++) {
        if (status === 'succeeded' || status === 'failed') break;
        await new Promise((r) => setTimeout(r, 20));
        const resPoll = await fetch(`${baseUrl}/v1/jobs/${job.id}`);
        const pollData = await resPoll.json();
        status = pollData.state;
      }
      assert.equal(status, 'succeeded');

      // 4. Caller deletes session via standard DELETE /v1/sessions/:id
      const resDel = await fetch(`${baseUrl}/v1/sessions/${session.id}`, {
        method: 'DELETE',
      });
      assert.equal(resDel.status, 202);
    } finally {
      await app.close();
    }
  } finally {
    await mockServer.close();
  }
});
