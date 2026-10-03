import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  LocalSandboxProvider,
  buildOneShotInterpreterRequest,
  estimateOneShotCost,
  runOneShotInterpreterJob,
} from '../src/index.js';

test('builds an ephemeral provider request from a snapshot profile', () => {
  const request = buildOneShotInterpreterRequest({
    profile: 'node-cli',
    command: { argv: ['node', '-e', 'console.log(1)'] },
  });

  assert.equal(request.executionMode, 'ephemeral_interpreter');
  assert.equal(request.snapshot, 'partners-node-cli');
  assert.equal(request.timeoutSeconds, 120);
  assert.deepEqual(request.resources, { cpu: 1, memoryGiB: 1, diskGiB: 3 });
  assert.equal(request.metadata.profile, 'node-cli');
});

test('runs the full one-shot lifecycle through the local provider', async () => {
  const provider = new LocalSandboxProvider();
  const events = [];

  const result = await runOneShotInterpreterJob(provider, {
    profile: 'node-cli',
    inputs: {
      files: [{ path: '/workspace/value.txt', content: '42' }],
    },
    command: {
      argv: [
        process.execPath,
        '-e',
        "const fs=require('fs'); const v=fs.readFileSync('value.txt','utf8'); fs.mkdirSync('out',{recursive:true}); fs.writeFileSync('out/answer.txt', v); console.log(v);",
      ],
      cwd: '/workspace',
    },
    artifactPolicy: {
      collect: ['workspace:/workspace/out/answer.txt'],
    },
    rates: {
      vcpuSecondUsd: 1,
      memoryGiBSecondUsd: 1,
      diskGiBSecondUsd: 0,
    },
  }, (event) => events.push(event));

  assert.equal(result.state, 'succeeded');
  assert.equal(result.profile, 'node-cli');
  assert.match(result.stdout, /42/);
  assert.ok(result.costEstimate.totalUsd > 0);
  assert.ok(events.some((event) => event.type === 'artifact.created'));

  const artifact = result.artifacts.find((item) => item.name === 'answer.txt');
  assert.ok(artifact);
  assert.equal(await readFile(artifact.localPath, 'utf8'), '42');
});

test('estimates one-shot compute, disk, artifact, and fixed cost', () => {
  const estimate = estimateOneShotCost({
    runtimeSeconds: 10,
    resources: { cpu: 2, memoryGiB: 4, diskGiB: 8 },
    artifactBytes: 1024 ** 3,
    rates: {
      vcpuSecondUsd: 0.01,
      memoryGiBSecondUsd: 0.001,
      diskGiBSecondUsd: 0.0001,
      artifactGiBMonthUsd: 0.2,
      fixedJobUsd: 0.05,
    },
  });

  assert.equal(Number(estimate.computeUsd.toFixed(2)), 0.24);
  assert.equal(Number(estimate.diskUsd.toFixed(3)), 0.008);
  assert.equal(estimate.artifactUsd, 0.2);
  assert.equal(Number(estimate.totalUsd.toFixed(3)), 0.498);
});
