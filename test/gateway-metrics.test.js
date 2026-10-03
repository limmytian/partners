import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ExecutionMode,
  InMemoryAgentExecutionGateway,
  JobState,
  createGatewayMetrics,
  instrumentArtifactStore,
} from '../src/index.js';

test('records job lifecycle and provider runtime metrics with bounded labels', async () => {
  const metrics = createGatewayMetrics({
    clock: () => Date.parse('2026-07-05T00:00:03.000Z'),
  });
  const gateway = new InMemoryAgentExecutionGateway({
    metrics,
    clock: () => new Date('2026-07-05T00:00:00.000Z'),
    provider: {
      name: 'fake-provider',
      runJob: async () => ({
        state: JobState.Succeeded,
        executionMode: ExecutionMode.EphemeralInterpreter,
        provider: 'fake-provider',
        providerJobId: 'provider_job_1',
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
        artifacts: [],
        completedAt: '2026-07-05T00:00:02.000Z',
      }),
    },
  });

  await gateway.runJob({
    id: 'job_metrics_1',
    executionMode: ExecutionMode.EphemeralInterpreter,
    command: { argv: [process.execPath, '-e', 'console.log("metrics")'] },
    timeoutSeconds: 30,
  });

  const text = metrics.prometheus();
  assert.match(
    text,
    /partners_gateway_jobs_started_total\{execution_mode="ephemeral_interpreter",provider="fake-provider"\} 1/,
  );
  assert.match(
    text,
    /partners_gateway_jobs_terminal_total\{execution_mode="ephemeral_interpreter",provider="fake-provider",state="succeeded"\} 1/,
  );
  assert.match(
    text,
    /partners_gateway_jobs_running\{execution_mode="ephemeral_interpreter",provider="fake-provider"\} 0/,
  );
  assert.match(
    text,
    /partners_gateway_provider_runtime_duration_ms_count\{execution_mode="ephemeral_interpreter",provider="fake-provider",state="succeeded"\} 1/,
  );
  assert.match(
    text,
    /partners_gateway_provider_runtime_duration_ms_sum\{execution_mode="ephemeral_interpreter",provider="fake-provider",state="succeeded"\} 2000/,
  );
});

test('exports Postgres pool gauges when store stats are available', () => {
  const metrics = createGatewayMetrics({
    storeStats: () => ({
      totalCount: 4,
      idleCount: 2,
      waitingCount: 1,
    }),
  });

  const text = metrics.prometheus();
  assert.match(text, /partners_gateway_postgres_pool_total 4/);
  assert.match(text, /partners_gateway_postgres_pool_idle 2/);
  assert.match(text, /partners_gateway_postgres_pool_waiting 1/);
});

test('counts artifact operation failures by backend and operation', async () => {
  const metrics = createGatewayMetrics();
  const artifactStore = instrumentArtifactStore({
    backend: 's3',
    writeArtifact: async () => {
      throw new Error('write failed');
    },
    readArtifact: async () => {
      throw new Error('read failed');
    },
    deleteArtifact: async () => {
      throw new Error('delete failed');
    },
  }, metrics);

  await assert.rejects(() => artifactStore.writeArtifact({ id: 'art_metrics_1' }), /write failed/);
  await assert.rejects(() => artifactStore.readArtifact('art_metrics_1'), /read failed/);
  await assert.rejects(() => artifactStore.deleteArtifact('art_metrics_1'), /delete failed/);

  const text = metrics.prometheus();
  assert.match(text, /partners_gateway_artifact_failures_total\{backend="s3",operation="write"\} 1/);
  assert.match(text, /partners_gateway_artifact_failures_total\{backend="s3",operation="read"\} 1/);
  assert.match(text, /partners_gateway_artifact_failures_total\{backend="s3",operation="delete"\} 1/);
});
