import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { LocalArtifactStore } from '../src/index.js';

test('writes, reads, lists, and deletes local artifacts without leaking local paths', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'partners-artifact-store-'));
  try {
    const store = new LocalArtifactStore({ rootDir });
    const artifact = store.writeArtifact({
      id: 'art_store_1',
      jobId: 'job_store_1',
      kind: 'file',
      name: '../report value.txt',
      content: 'artifact payload',
      contentType: 'text/plain',
      retentionClass: 'review',
      metadata: { source: 'test' },
      createdAt: '2026-07-05T00:00:00.000Z',
    });

    assert.equal(artifact.name, 'report_value.txt');
    assert.equal(artifact.sizeBytes, Buffer.byteLength('artifact payload'));
    assert.equal(
      artifact.sha256,
      createHash('sha256').update('artifact payload').digest('hex'),
    );
    assert.equal(artifact.storageUri, 'artifact://local/art_store_1');
    assert.equal(artifact.downloadHandle, 'artifact://local/art_store_1');
    assert.equal(artifact.localPath, undefined);

    const listed = store.listArtifacts({ jobId: 'job_store_1' });
    assert.deepEqual(listed, [artifact]);
    assert.equal(store.listArtifacts({ jobId: 'other_job' }).length, 0);

    const read = store.readArtifact('art_store_1');
    assert.equal(read.artifact.localPath, undefined);
    assert.equal(read.content.toString('utf8'), 'artifact payload');

    assert.equal(store.deleteArtifact('art_store_1'), true);
    assert.equal(store.readArtifact('art_store_1'), null);
    assert.equal(store.deleteArtifact('art_store_1'), false);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('copies artifact bytes from a provider-local path into the store root', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'partners-artifact-store-'));
  const sourceDir = await mkdtemp(path.join(tmpdir(), 'partners-artifact-source-'));
  try {
    const sourcePath = path.join(sourceDir, 'source.txt');
    await writeFile(sourcePath, 'from provider');

    const store = new LocalArtifactStore({ rootDir });
    const artifact = store.writeArtifact({
      id: 'art_store_2',
      jobId: 'job_store_2',
      name: 'source.txt',
      localPath: sourcePath,
    });

    await writeFile(sourcePath, 'mutated provider path');
    const read = store.readArtifact(artifact.id);
    assert.equal(read.content.toString('utf8'), 'from provider');
    assert.equal(read.artifact.storageUri, 'artifact://local/art_store_2');
  } finally {
    await rm(rootDir, { recursive: true, force: true });
    await rm(sourceDir, { recursive: true, force: true });
  }
});
