import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { S3ArtifactStore } from '../src/index.js';

test('writes, reads, signs, and deletes S3 artifacts without leaking local paths', async () => {
  const transport = new InMemoryS3Transport();
  const store = new S3ArtifactStore({
    endpoint: 'http://127.0.0.1:19000',
    bucket: 'partners-artifacts',
    accessKeyId: 'partners',
    secretAccessKey: 'partners-secret',
    prefix: 'gateway-artifacts',
    fetchImpl: transport,
  });

  const artifact = await store.writeArtifact({
    id: 'art_s3_1',
    jobId: 'job_s3_1',
    kind: 'file',
    name: '../report value.txt',
    content: 'artifact payload',
    contentType: 'text/plain',
    retentionClass: 'audit',
    metadata: { source: 'test' },
    createdAt: '2026-07-05T00:00:00.000Z',
  });

  assert.equal(artifact.name, 'report_value.txt');
  assert.equal(artifact.storageUri, 's3://partners-artifacts/gateway-artifacts/job_s3_1/art_s3_1/report_value.txt');
  assert.equal(artifact.downloadHandle, 'artifact://s3/art_s3_1');
  assert.equal(artifact.localPath, undefined);
  assert.equal(artifact.metadata.s3.key, 'gateway-artifacts/job_s3_1/art_s3_1/report_value.txt');
  assert.equal(artifact.sha256, createHash('sha256').update('artifact payload').digest('hex'));
  assert.match(transport.calls[0].options.headers.authorization, /^AWS4-HMAC-SHA256 /);
  assert.match(transport.calls[0].options.headers['x-amz-tagging'], /retentionClass=audit/);

  const recovered = new S3ArtifactStore({
    endpoint: 'http://127.0.0.1:19000',
    bucket: 'partners-artifacts',
    accessKeyId: 'partners',
    secretAccessKey: 'partners-secret',
    fetchImpl: transport,
  });
  const read = await recovered.readArtifact('art_s3_1', artifact);
  assert.equal(read.artifact.localPath, undefined);
  assert.equal(read.content.toString('utf8'), 'artifact payload');

  const signedUrl = recovered.createSignedDownloadUrl('art_s3_1', artifact, { expiresInSeconds: 60 });
  assert.match(signedUrl, /X-Amz-Signature=/);
  assert.doesNotMatch(signedUrl, /workspace|tmp/);

  assert.equal(await store.deleteArtifact('art_s3_1'), true);
  assert.equal(await recovered.readArtifact('art_s3_1', artifact), null);
});

test('writes and reads artifacts against live MinIO when S3_ENDPOINT is set', {
  skip: !process.env.S3_ENDPOINT,
}, async () => {
  const store = new S3ArtifactStore({
    endpoint: process.env.S3_ENDPOINT,
    bucket: process.env.S3_BUCKET,
    region: process.env.S3_REGION ?? 'us-east-1',
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    prefix: `test-artifacts/${Date.now()}`,
  });

  const artifact = await store.writeArtifact({
    id: 'art_s3_live_1',
    jobId: 'job_s3_live_1',
    name: 'value.txt',
    content: 'minio payload',
  });

  const read = await store.readArtifact(artifact.id, artifact);
  assert.equal(read.content.toString('utf8'), 'minio payload');
  assert.equal(read.artifact.storageUri, artifact.storageUri);
  assert.equal(await store.deleteArtifact(artifact.id), true);
});

class InMemoryS3Transport {
  constructor() {
    this.objects = new Map();
    this.calls = [];
  }

  async request(url, options) {
    const requestUrl = new URL(url);
    this.calls.push({ url: requestUrl, options });
    const key = requestUrl.pathname;
    if (options.method === 'PUT') {
      this.objects.set(key, Buffer.from(options.body));
      return { ok: true, status: 200, headers: {}, body: '', buffer: Buffer.alloc(0) };
    }
    if (options.method === 'GET') {
      const body = this.objects.get(key);
      return body
        ? { ok: true, status: 200, headers: {}, body: body.toString('utf8'), buffer: body }
        : { ok: false, status: 404, headers: {}, body: 'missing', buffer: Buffer.alloc(0) };
    }
    if (options.method === 'DELETE') {
      this.objects.delete(key);
      return { ok: true, status: 204, headers: {}, body: '', buffer: Buffer.alloc(0) };
    }
    throw new Error(`Unexpected method: ${options.method}`);
  }
}
