import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SandboxAgentContract,
  assertExecutionJobRequest,
  assertImmutableSandboxImage,
  assertSandboxConfiguration,
  normalizeSandboxConfiguration,
} from '../src/index.js';

const digest = 'a'.repeat(64);

test('accepts an immutable allowlisted sandbox image and safe bootstrap contract', () => {
  const config = {
    profile: 'python-tools',
    image: `ghcr.io/limmytian/partners/python-tools@sha256:${digest}`,
    imagePullSecretRef: 'platform://registry/partners',
    agentContract: { port: SandboxAgentContract.port, workspacePath: '/workspace' },
    init: {
      files: [{ path: '/workspace/bootstrap.sh', content: '#!/bin/sh\n' }],
      argv: ['/workspace/bootstrap.sh'],
      env: { BOOTSTRAP_VERSION: 'v1' },
      timeoutSeconds: 30,
      idempotencyKey: 'bootstrap-v1',
      version: 'v1',
    },
  };

  assert.equal(assertSandboxConfiguration(config, {
    allowedRegistries: ['ghcr.io'],
    allowedProfiles: ['python-tools'],
    requireRegistryAllowlist: true,
  }), true);
  assert.deepEqual(normalizeSandboxConfiguration(config), config);
  assert.doesNotThrow(() => assertExecutionJobRequest({
    executionMode: 'ephemeral_interpreter',
    command: { argv: ['echo', 'ok'] },
    timeoutSeconds: 10,
    sandbox: config,
  }));
});

test('rejects mutable or unallowlisted images and raw registry secrets', () => {
  assert.throws(() => assertImmutableSandboxImage('ghcr.io/limmytian/partners/tools:latest'), /immutable/);
  assert.throws(() => assertSandboxConfiguration({
    image: `evil.example/tools@sha256:${digest}`,
  }, {
    allowedRegistries: ['ghcr.io'],
    requireRegistryAllowlist: true,
  }), /not allowed/);
  assert.throws(() => assertSandboxConfiguration({
    imagePullSecretRef: 'platform://registry/partners',
    init: { env: { REGISTRY_TOKEN: 'raw-token-value' } },
  }), /secret references/);
});

test('keeps init files inside the workspace and rejects path traversal', () => {
  assert.throws(() => assertSandboxConfiguration({
    init: { files: [{ path: '/tmp/bootstrap.sh', content: 'bad' }] },
  }), /workspace/);
  assert.throws(() => assertSandboxConfiguration({
    init: { files: [{ path: '/workspace/../etc/passwd', content: 'bad' }] },
  }), /workspace/);
  assert.throws(() => assertSandboxConfiguration({
    init: { files: [{ path: '/workspace/file', content: 'a', contentBase64: 'Yg==' }] },
  }), /exactly one/);
});
