import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ExecutionMode,
  InMemoryAgentExecutionGateway,
  InMemoryGatewayStore,
  JobState,
  LocalArtifactStore,
  LocalSandboxProvider,
} from '../src/index.js';

test('runs a job, stores status, replays events, and indexes artifacts', async () => {
  const gateway = new InMemoryAgentExecutionGateway({
    provider: new LocalSandboxProvider(),
  });
  const streamed = [];

  const result = await gateway.runJob({
    id: 'job_gateway_1',
    executionMode: ExecutionMode.EphemeralInterpreter,
    inputs: {
      files: [{ path: '/workspace/input.txt', content: 'gateway' }],
    },
    command: {
      argv: [
        process.execPath,
        '-e',
        "const fs=require('fs'); const v=fs.readFileSync('input.txt','utf8'); fs.mkdirSync('out',{recursive:true}); fs.writeFileSync('out/value.txt', v); console.log(v);",
      ],
      cwd: '/workspace',
    },
    timeoutSeconds: 30,
    artifactPolicy: {
      collect: ['workspace:/workspace/out/value.txt'],
    },
  }, (event) => streamed.push(event));

  assert.equal(result.state, JobState.Succeeded);
  assert.equal((await gateway.getJob('job_gateway_1')).state, JobState.Succeeded);
  assert.ok(streamed.some((event) => event.type === 'job.state' && event.state === JobState.Queued));
  const events = await gateway.listJobEvents('job_gateway_1');
  assert.deepEqual(events.map((event) => event.sequence), events.map((_event, index) => index + 1));
  assert.ok((await gateway.listJobEvents('job_gateway_1', { afterSequence: 1 })).length > 0);

  const artifacts = await gateway.listJobArtifacts('job_gateway_1');
  const artifact = artifacts.find((item) => item.name === 'value.txt');
  assert.ok(artifact);
  assert.equal(await readFile(artifact.localPath, 'utf8'), 'gateway');
});

test('copies provider artifacts into an ArtifactStore before indexing manifests', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'partners-gateway-artifacts-'));
  try {
    const gateway = new InMemoryAgentExecutionGateway({
      provider: new LocalSandboxProvider(),
      artifactStore: new LocalArtifactStore({ rootDir }),
    });

    const result = await gateway.runJob({
      id: 'job_gateway_store_1',
      executionMode: ExecutionMode.EphemeralInterpreter,
      inputs: {
        files: [{ path: '/workspace/input.txt', content: 'stored through gateway' }],
      },
      command: {
        argv: [
          process.execPath,
          '-e',
          "const fs=require('fs'); const v=fs.readFileSync('input.txt','utf8'); fs.mkdirSync('out',{recursive:true}); fs.writeFileSync('out/value.txt', v);",
        ],
        cwd: '/workspace',
      },
      timeoutSeconds: 30,
      artifactPolicy: {
        collect: ['workspace:/workspace/out/value.txt'],
      },
    });

    assert.equal(result.state, JobState.Succeeded);
    const artifact = (await gateway.listJobArtifacts('job_gateway_store_1'))
      .find((item) => item.name === 'value.txt');
    assert.ok(artifact);
    assert.equal(artifact.localPath, undefined);
    assert.equal(artifact.storageUri, `artifact://local/${artifact.id}`);
    assert.equal(artifact.downloadHandle, `artifact://local/${artifact.id}`);

    const stored = await gateway.readArtifact(artifact.id);
    assert.equal(stored.artifact.localPath, undefined);
    assert.equal(stored.content.toString('utf8'), 'stored through gateway');
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('manages provider-backed workspace sessions', async () => {
  const gateway = new InMemoryAgentExecutionGateway({
    provider: new LocalSandboxProvider(),
  });

  const session = await gateway.createSession({
    id: 'ses_gateway_1',
    persistence: { kind: 'stopped' },
  });
  assert.equal(session.id, 'ses_gateway_1');

  const fetched = await gateway.getSession('ses_gateway_1');
  assert.equal(fetched.state, 'ready');

  const deleted = await gateway.deleteSession('ses_gateway_1');
  assert.equal(deleted.state, 'deleted');
});

test('records cancel_requested and forwards cancellation to provider', async () => {
  const calls = [];
  const provider = {
    name: 'fake',
    runJob: async () => ({
      id: 'job_cancel_1',
      state: JobState.Cancelled,
      executionMode: ExecutionMode.EphemeralInterpreter,
      provider: 'fake',
      exitCode: null,
      stdout: '',
      stderr: '',
      artifacts: [],
      completedAt: new Date().toISOString(),
    }),
    cancel: async (jobId, reason) => calls.push({ jobId, reason }),
  };
  const gateway = new InMemoryAgentExecutionGateway({ provider });

  const running = gateway.runJob({
    id: 'job_cancel_1',
    executionMode: ExecutionMode.EphemeralInterpreter,
    command: { argv: [process.execPath, '-e', 'console.log(1)'] },
    timeoutSeconds: 30,
  });
  await gateway.cancel('job_cancel_1', 'user requested');
  await running;

  assert.deepEqual(calls, [{ jobId: 'job_cancel_1', reason: 'user requested' }]);
  assert.ok((await gateway.listJobEvents('job_cancel_1')).some((event) => (
    event.type === 'job.state' && event.state === JobState.CancelRequested
  )));
});

test('converts provider exceptions into failed job results', async () => {
  const gateway = new InMemoryAgentExecutionGateway({
    provider: {
      name: 'failing',
      runJob: async () => {
        throw new Error('provider exploded');
      },
    },
  });

  const result = await gateway.runJob({
    id: 'job_failed_1',
    executionMode: ExecutionMode.EphemeralInterpreter,
    command: { argv: [process.execPath, '-e', 'console.log(1)'] },
    timeoutSeconds: 30,
  });

  assert.equal(result.state, JobState.Failed);
  assert.match(result.stderr, /provider exploded/);
  assert.equal((await gateway.getJob('job_failed_1')).state, JobState.Failed);
  assert.ok((await gateway.listJobEvents('job_failed_1')).some((event) => event.type === 'job.final'));
});

test('serializes async store writes from provider event callbacks', async () => {
  const gateway = new InMemoryAgentExecutionGateway({
    store: new DelayedGatewayStore(),
    provider: {
      name: 'async-provider',
      runJob: async (_request, onEvent) => {
        onEvent({ type: 'job.state', state: JobState.Running });
        onEvent({ type: 'job.state', state: JobState.Succeeded });
        return {
          state: JobState.Succeeded,
          executionMode: ExecutionMode.EphemeralInterpreter,
          provider: 'async-provider',
          exitCode: 0,
          stdout: 'done',
          stderr: '',
          artifacts: [],
          completedAt: '2026-07-05T00:00:01.000Z',
        };
      },
    },
  });

  const result = await gateway.runJob({
    id: 'job_async_store_1',
    executionMode: ExecutionMode.EphemeralInterpreter,
    command: { argv: [process.execPath, '-e', 'console.log("done")'] },
    timeoutSeconds: 30,
  });

  assert.equal(result.state, JobState.Succeeded);
  assert.deepEqual(
    (await gateway.listJobEvents('job_async_store_1')).map((event) => event.sequence),
    [1, 2, 3],
  );
  assert.equal((await gateway.getJob('job_async_store_1')).state, JobState.Succeeded);
});

class DelayedGatewayStore extends InMemoryGatewayStore {
  async nextEventSequence() {
    await delay();
    return super.nextEventSequence();
  }

  async saveJob(job) {
    await delay();
    return super.saveJob(job);
  }

  async appendEvent(jobId, event) {
    await delay();
    return super.appendEvent(jobId, event);
  }
}

function delay() {
  return new Promise((resolve) => setTimeout(resolve, 1));
}
