import assert from 'node:assert/strict';
import test from 'node:test';

import {
  E2BProtocolAdapter,
  PROVIDER_CAPABILITIES,
  SandboxCapability,
  buildArtifactPublishContract,
  negotiateCapabilities,
} from '../src/index.js';

test('capabilities matrix: negotiate capabilities across provider tiers', () => {
  // 1. Local provider negotiation
  const localNegotiation = negotiateCapabilities('local', [
    SandboxCapability.ProcessExec,
    SandboxCapability.FileRead,
  ]);
  assert.equal(localNegotiation.provider, 'local');
  assert.equal(localNegotiation.satisfied, true);
  assert.equal(localNegotiation.tier, 'basic_pod');
  assert.equal(localNegotiation.missing.length, 0);

  // 2. Kubernetes Pod requesting MicroVM feature fails
  const k8sFailed = negotiateCapabilities('kubernetes', [
    SandboxCapability.ProcessExec,
    SandboxCapability.MemorySnapshot,
  ]);
  assert.equal(k8sFailed.satisfied, false);
  assert.equal(k8sFailed.tier, 'basic_pod');
  assert.deepEqual(k8sFailed.missing, [SandboxCapability.MemorySnapshot]);

  // 3. CubeSandbox MicroVM provider supports full matrix
  const cubeNegotiation = negotiateCapabilities('cubesandbox', [
    SandboxCapability.ProcessExec,
    SandboxCapability.MemorySnapshot,
    SandboxCapability.InstantFork,
    SandboxCapability.Sub60msColdStart,
  ]);
  assert.equal(cubeNegotiation.satisfied, true);
  assert.equal(cubeNegotiation.tier, 'microvm_privileged');
  assert.equal(cubeNegotiation.missing.length, 0);
});

test('buildArtifactPublishContract validates fields and produces published record', () => {
  const record = buildArtifactPublishContract({
    name: 'model_weights.bin',
    path: '/workspace/output/model.bin',
    retentionClass: 'release',
    metadata: { epoch: 10 },
  });

  assert.equal(record.name, 'model_weights.bin');
  assert.equal(record.path, '/workspace/output/model.bin');
  assert.equal(record.retentionClass, 'release');
  assert.equal(record.status, 'published');
  assert.deepEqual(record.metadata, { epoch: 10 });
  assert.ok(record.id.startsWith('art_pub_'));

  assert.throws(() => buildArtifactPublishContract({}), /requires a non-empty name/);
  assert.throws(() => buildArtifactPublishContract({ name: 'test' }), /requires a path/);
});

test('E2BProtocolAdapter translates operations to sandbox data plane', async () => {
  const requests = [];
  const mockClient = {
    async request(url, options) {
      requests.push({ url, options });
      if (url === '/v1/files/read') return { contentBase64: Buffer.from('hello').toString('base64') };
      if (url === '/v1/exec') return { exitCode: 0, stdout: 'success' };
      if (url === '/v1/artifacts/publish') return { published: true };
      if (url === '/v1/microvm/snapshot') return { snapshotId: 'snap_123' };
      if (url === '/v1/microvm/fork') return { forkedSessionId: 'ses_fork_456' };
      return { ok: true };
    },
  };

  const adapter = new E2BProtocolAdapter({
    client: mockClient,
    capabilities: PROVIDER_CAPABILITIES.cubesandbox,
  });

  // 1. File read
  const fileRes = await adapter.read('/workspace/test.txt');
  assert.ok(fileRes.contentBase64);
  assert.equal(requests[0].url, '/v1/files/read');

  // 2. Process start
  const procRes = await adapter.startProcess('ls -la');
  assert.equal(procRes.exitCode, 0);
  assert.equal(requests[1].url, '/v1/exec');
  assert.deepEqual(requests[1].options.body.argv, ['/bin/sh', '-c', 'ls -la']);

  // 3. Artifact publish
  await adapter.publishArtifact('report.pdf', '/workspace/report.pdf');
  assert.equal(requests[2].url, '/v1/artifacts/publish');
  assert.equal(requests[2].options.body.name, 'report.pdf');

  // 4. MicroVM Snapshot & Fork
  const snapRes = await adapter.createSnapshot('checkpoint-1');
  assert.equal(snapRes.snapshotId, 'snap_123');
  assert.equal(requests[3].url, '/v1/microvm/snapshot');

  const forkRes = await adapter.fork('snap_123');
  assert.equal(forkRes.forkedSessionId, 'ses_fork_456');
  assert.equal(requests[4].url, '/v1/microvm/fork');

  // Non-privileged adapter should reject MicroVM operations
  const basicAdapter = new E2BProtocolAdapter({
    client: mockClient,
    capabilities: PROVIDER_CAPABILITIES.kubernetes,
  });
  await assert.rejects(
    () => basicAdapter.createSnapshot('fail'),
    /MemorySnapshot capability not supported by this provider tier/
  );
});
