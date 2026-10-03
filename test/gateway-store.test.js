import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ExecutionMode,
  InMemoryAgentExecutionGateway,
  InMemoryGatewayStore,
  JobState,
} from '../src/index.js';

test('stores gateway lifecycle records behind an injected GatewayStore', async () => {
  const store = new InMemoryGatewayStore();
  const provider = {
    name: 'fake',
    runJob: async (_request, onEvent) => {
      onEvent({
        type: 'artifact.created',
        artifact: {
          id: 'art_store_1',
          kind: 'file',
          name: 'result.txt',
          sizeBytes: 6,
          createdAt: new Date().toISOString(),
        },
      });
      return {
        state: JobState.Succeeded,
        executionMode: ExecutionMode.EphemeralInterpreter,
        provider: 'fake',
        exitCode: 0,
        stdout: 'stored',
        stderr: '',
        artifacts: [],
        completedAt: new Date().toISOString(),
      };
    },
    cancel: async () => {},
  };
  const gateway = new InMemoryAgentExecutionGateway({ provider, store });

  await gateway.runJob({
    id: 'job_store_1',
    executionMode: ExecutionMode.EphemeralInterpreter,
    command: { argv: ['echo', 'stored'] },
    timeoutSeconds: 30,
  });

  assert.equal(store.getJob('job_store_1').state, JobState.Succeeded);
  assert.equal((await gateway.getArtifact('art_store_1')).name, 'result.txt');
  assert.deepEqual(
    store.listJobEvents('job_store_1').map((event) => event.sequence),
    [1, 2],
  );
});

test('tracks cancellation markers and idempotency keys in the in-memory store', async () => {
  const store = new InMemoryGatewayStore();
  const gateway = new InMemoryAgentExecutionGateway({
    store,
    provider: {
      name: 'fake',
      runJob: async () => ({
        state: JobState.Cancelled,
        executionMode: ExecutionMode.EphemeralInterpreter,
        provider: 'fake',
        exitCode: null,
        stdout: '',
        stderr: '',
        artifacts: [],
        completedAt: new Date().toISOString(),
      }),
      cancel: async () => {},
    },
  });

  const running = gateway.runJob({
    id: 'job_store_cancel_1',
    executionMode: ExecutionMode.EphemeralInterpreter,
    command: { argv: ['sleep', '1'] },
    timeoutSeconds: 30,
  });
  await gateway.cancel('job_store_cancel_1', 'operator stop');
  await running;

  assert.equal(store.getCancellation('job_store_cancel_1').reason, 'operator stop');

  store.saveIdempotencyKey('tenant:req:abc', {
    scope: 'jobs:create',
    requestHash: 'hash_1',
    resourceType: 'job',
    resourceId: 'job_store_cancel_1',
    createdAt: '2026-07-05T00:00:00.000Z',
    expiresAt: '2026-07-06T00:00:00.000Z',
  });

  assert.equal(store.getIdempotencyKey('tenant:req:abc').resourceId, 'job_store_cancel_1');
});
