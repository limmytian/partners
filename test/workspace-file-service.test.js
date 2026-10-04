import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';

import {
  GatewayServiceAuthorizer,
  InMemoryAgentExecutionGateway,
  InMemoryGatewayStore,
  LocalSandboxProvider,
  createAgentExecutionGatewayServer,
  createArchiveDownloadStream,
  createSingleFileDownloadStream,
  listWorkspaceTree,
  readWorkspaceFilePreview,
} from '../src/index.js';

test('workspace file service: lists tree, previews content, and downloads archive', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'partners-ws-srv-'));

  try {
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.mkdir(path.join(root, '.hidden_dir'), { recursive: true });
    await fs.writeFile(path.join(root, 'README.md'), '# Hello Partners\nWelcome to Partners sandbox.');
    await fs.writeFile(path.join(root, 'src/app.js'), 'console.log("running");\n');
    await fs.writeFile(path.join(root, '.env'), 'SECRET_KEY=123456\n');

    // 1. listWorkspaceTree
    const tree = await listWorkspaceTree(root, { subpath: '.' });
    assert.equal(tree.path, '.');
    const readme = tree.entries.find((e) => e.name === 'README.md');
    assert.ok(readme);
    assert.equal(readme.type, 'file');
    assert.equal(readme.isSensitive, false);

    const envFile = tree.entries.find((e) => e.name === '.env');
    assert.ok(envFile);
    assert.equal(envFile.isSensitive, true);
    assert.equal(envFile.sensitivityAction, 'block');

    const srcDir = tree.entries.find((e) => e.name === 'src');
    assert.ok(srcDir);
    assert.equal(srcDir.type, 'directory');
    assert.ok(srcDir.children.some((c) => c.name === 'app.js'));

    // 2. readWorkspaceFilePreview (safe file)
    const readmePreview = await readWorkspaceFilePreview(root, 'README.md');
    assert.equal(readmePreview.name, 'README.md');
    assert.ok(readmePreview.content.includes('# Hello Partners'));
    assert.equal(readmePreview.isSensitive, false);
    assert.equal(readmePreview.redacted, false);

    // 3. readWorkspaceFilePreview (sensitive file - redacted by default)
    const envPreview = await readWorkspaceFilePreview(root, '.env', { allowSensitiveRedact: true });
    assert.equal(envPreview.isSensitive, true);
    assert.equal(envPreview.redacted, true);
    assert.ok(!envPreview.content.includes('123456'));
    assert.ok(envPreview.content.includes('[REDACTED]'));

    // 4. single file download stream
    const singleDownload = await createSingleFileDownloadStream(root, 'README.md');
    assert.equal(singleDownload.filename, 'README.md');
    assert.equal(singleDownload.mimeType, 'text/markdown; charset=utf-8');

    // Sensitive file download should be blocked
    await assert.rejects(
      () => createSingleFileDownloadStream(root, '.env'),
      /Direct download of sensitive file is restricted/
    );

    // 5. archive download stream
    const archive = await createArchiveDownloadStream(root, { paths: ['.'], archiveName: 'test.tar.gz' });
    assert.equal(archive.filename, 'test.tar.gz');

    const chunks = [];
    for await (const chunk of archive.stream) {
      chunks.push(chunk);
    }
    const tarGzBuffer = Buffer.concat(chunks);
    const unzipped = zlib.gunzipSync(tarGzBuffer);
    assert.ok(unzipped.length > 512);
    // Unzipped tar contains README.md and src/app.js, but NOT .env
    const unzippedStr = unzipped.toString('binary');
    assert.ok(unzippedStr.includes('README.md'));
    assert.ok(unzippedStr.includes('app.js'));
    assert.ok(!unzippedStr.includes('SECRET_KEY=123456'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('HTTP gateway: workspace tree, file preview, and download endpoints', async () => {
  const provider = new LocalSandboxProvider();
  const store = new InMemoryGatewayStore();
  const gateway = new InMemoryAgentExecutionGateway({ provider, store });
  const authorizer = new GatewayServiceAuthorizer();
  const { server, close } = createAgentExecutionGatewayServer({ gateway, authorizer });

  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // Create session
    const sessionRes = await fetch(`${baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(sessionRes.status, 202);
    const session = await sessionRes.json();
    const sessionId = session.id;

    // Get the actual session workspace path from provider
    const internalSession = await provider.getSession(sessionId);
    await fs.writeFile(path.join(internalSession.workspacePath, 'package.json'), '{"name":"demo"}');
    await fs.writeFile(path.join(internalSession.workspacePath, '.env'), 'TOKEN=xyz123');

    // 1. GET /v1/sessions/:id/workspace/tree
    const treeRes = await fetch(`${baseUrl}/v1/sessions/${sessionId}/workspace/tree`);
    assert.equal(treeRes.status, 200);
    const treeData = await treeRes.json();
    assert.equal(treeData.path, '.');
    assert.ok(treeData.entries.some((e) => e.name === 'package.json'));

    // 2. GET /v1/sessions/:id/workspace/file?path=package.json
    const fileRes = await fetch(`${baseUrl}/v1/sessions/${sessionId}/workspace/file?path=package.json`);
    assert.equal(fileRes.status, 200);
    const fileData = await fileRes.json();
    assert.equal(fileData.path, 'package.json');
    assert.ok(fileData.content.includes('demo'));

    // 3. GET /v1/sessions/:id/workspace/file?path=.env (sensitive redaction)
    const envRes = await fetch(`${baseUrl}/v1/sessions/${sessionId}/workspace/file?path=.env`);
    assert.equal(envRes.status, 200);
    const envData = await envRes.json();
    assert.equal(envData.isSensitive, true);
    assert.ok(!envData.content.includes('xyz123'));

    // 4. GET /v1/sessions/:id/workspace/download?path=package.json
    const dlRes = await fetch(`${baseUrl}/v1/sessions/${sessionId}/workspace/download?path=package.json`);
    assert.equal(dlRes.status, 200);
    assert.equal(dlRes.headers.get('content-disposition'), 'attachment; filename="package.json"');
    assert.equal(dlRes.headers.get('x-content-type-options'), 'nosniff');
    const dlContent = await dlRes.text();
    assert.equal(dlContent, '{"name":"demo"}');

    // 5. GET /v1/sessions/:id/workspace/download (archive download)
    const archiveRes = await fetch(`${baseUrl}/v1/sessions/${sessionId}/workspace/download`);
    assert.equal(archiveRes.status, 200);
    assert.equal(archiveRes.headers.get('content-type'), 'application/gzip');
    assert.ok(archiveRes.headers.get('content-disposition').includes('.tar.gz'));
    const archiveBuffer = Buffer.from(await archiveRes.arrayBuffer());
    const unzipped = zlib.gunzipSync(archiveBuffer);
    assert.ok(unzipped.toString('binary').includes('package.json'));

    // Clean up session
    await fetch(`${baseUrl}/v1/sessions/${sessionId}`, { method: 'DELETE' });
  } finally {
    await close();
  }
});

test('workspace file service: syncs files and extracts tar archives safely', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'partners-ws-sync-'));

  try {
    const { syncWorkspaceFiles, extractTarGzToWorkspace } = await import('../src/workspaces/workspace-file-service.js');

    // 1. Batch sync json files
    const syncRes = await syncWorkspaceFiles(root, [
      { path: 'docs/spec.md', content: '# Partners Spec' },
      { path: 'src/config.json', content: JSON.stringify({ port: 8080 }) },
      { path: 'images/pixel.bin', contentBase64: Buffer.from([0x01, 0x02, 0x03]).toString('base64') },
    ]);

    assert.equal(syncRes.count, 3);
    assert.ok(syncRes.totalBytes > 0);
    assert.equal(await fs.readFile(path.join(root, 'docs/spec.md'), 'utf8'), '# Partners Spec');
    assert.deepEqual(await fs.readFile(path.join(root, 'images/pixel.bin')), Buffer.from([0x01, 0x02, 0x03]));

    // 2. Sensitive file write blocked by default policy
    await assert.rejects(
      () => syncWorkspaceFiles(root, [{ path: '.env', content: 'SECRET=123' }]),
      /Writing sensitive file is restricted by policy/
    );

    // 3. Path traversal blocked
    await assert.rejects(
      () => syncWorkspaceFiles(root, [{ path: '../../etc/passwd', content: 'hacked' }]),
      /Path traversal detected|escapes workspace/i
    );

    // 4. Archive extraction test
    const { createArchiveDownloadStream } = await import('../src/workspaces/workspace-file-service.js');
    const archive = await createArchiveDownloadStream(root, { paths: ['docs'], archiveName: 'docs.tar.gz' });
    const chunks = [];
    for await (const chunk of archive.stream) chunks.push(chunk);
    const archiveBuf = Buffer.concat(chunks);

    const destDir = await fs.mkdtemp(path.join(os.tmpdir(), 'partners-ws-dest-'));
    try {
      const extractRes = await extractTarGzToWorkspace(destDir, archiveBuf);
      assert.ok(extractRes.count >= 1);
      assert.equal(await fs.readFile(path.join(destDir, 'docs/spec.md'), 'utf8'), '# Partners Spec');
    } finally {
      await fs.rm(destDir, { recursive: true, force: true });
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('HTTP gateway: POST /v1/sessions/:id/workspace/sync handles JSON files and tar.gz streaming injection', async () => {
  const provider = new LocalSandboxProvider();
  const store = new InMemoryGatewayStore();
  const gateway = new InMemoryAgentExecutionGateway({ provider, store });
  const authorizer = new GatewayServiceAuthorizer({
    tokens: [
      { token: 'write-token', scopes: ['sessions:write', 'sessions:create', 'sessions:read'] },
      { token: 'readonly-token', scopes: ['sessions:read'] },
    ],
  });
  const { server, close } = createAgentExecutionGatewayServer({ gateway, authorizer });

  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const sessionRes = await fetch(`${baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer write-token',
      },
      body: JSON.stringify({ id: 'ses_sync_test' }),
    });
    assert.equal(sessionRes.status, 202);

    // 1. Unauthorized sync attempt
    const unauthRes = await fetch(`${baseUrl}/v1/sessions/ses_sync_test/workspace/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer readonly-token',
      },
      body: JSON.stringify({ files: [{ path: 'a.txt', content: 'test' }] }),
    });
    assert.equal(unauthRes.status, 403);

    // 2. Authorized JSON sync
    const jsonSyncRes = await fetch(`${baseUrl}/v1/sessions/ses_sync_test/workspace/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer write-token',
      },
      body: JSON.stringify({
        files: [
          { path: 'src/index.js', content: 'export const hello = "world";\n' },
          { path: 'data/info.txt', content: 'some info\n' },
        ],
      }),
    });
    assert.equal(jsonSyncRes.status, 200);
    const jsonResult = await jsonSyncRes.json();
    assert.equal(jsonResult.status, 'synced');
    assert.equal(jsonResult.count, 2);

    // Verify file content via GET preview
    const previewRes = await fetch(`${baseUrl}/v1/sessions/ses_sync_test/workspace/file?path=src/index.js`, {
      headers: { Authorization: 'Bearer write-token' },
    });
    assert.equal(previewRes.status, 200);
    const previewData = await previewRes.json();
    assert.equal(previewData.content, 'export const hello = "world";\n');

    // 3. Streaming tar.gz sync
    const { createArchiveDownloadStream } = await import('../src/workspaces/workspace-file-service.js');
    const internalSession = await provider.getSession('ses_sync_test');
    const archiveStream = await createArchiveDownloadStream(internalSession.workspacePath, { paths: ['src'] });
    const chunks = [];
    for await (const chunk of archiveStream.stream) chunks.push(chunk);
    const tarGzBuffer = Buffer.concat(chunks);

    const streamSyncRes = await fetch(`${baseUrl}/v1/sessions/ses_sync_test/workspace/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/gzip',
        Authorization: 'Bearer write-token',
      },
      body: tarGzBuffer,
    });
    assert.equal(streamSyncRes.status, 200);
    const streamResult = await streamSyncRes.json();
    assert.equal(streamResult.status, 'synced');
    assert.ok(streamResult.count >= 1);
  } finally {
    await close();
  }
});
