import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createAgentExecutionGatewayServer,
  createGatewayMetrics,
  ExecutionMode,
  GatewayServiceAuthorizer,
  InMemoryAgentExecutionGateway,
  InMemoryGatewayStore,
  JobState,
  LocalArtifactStore,
  LocalSandboxProvider,
} from '../src/index.js';

test('serves health, sessions, jobs, events, artifacts, and downloads over HTTP', async () => {
  const harness = await startHarness();
  try {
    const health = await jsonFetch(harness.url('/health'));
    assert.equal(health.status, 200);
    assert.deepEqual(health.body, { status: 'ok' });

    const ready = await jsonFetch(harness.url('/ready'));
    assert.equal(ready.status, 200);
    assert.equal(ready.body.status, 'ready');

    const createdSession = await jsonFetch(harness.url('/v1/sessions'), {
      method: 'POST',
      body: {
        id: 'ses_http_1',
        tenantId: 'tenant_1',
        projectId: 'project_1',
        persistence: { kind: 'stopped' },
      },
    });
    assert.equal(createdSession.status, 202);
    assert.equal(createdSession.body.id, 'ses_http_1');
    assert.equal(createdSession.body.workspacePath, undefined);

    const fetchedSession = await jsonFetch(harness.url('/v1/sessions/ses_http_1'));
    assert.equal(fetchedSession.status, 200);
    assert.equal(fetchedSession.body.state, 'ready');

    const createdJob = await jsonFetch(harness.url('/v1/jobs'), {
      method: 'POST',
      body: {
        id: 'job_http_1',
        executionMode: ExecutionMode.EphemeralInterpreter,
        inputs: {
          files: [{ path: '/workspace/input.txt', content: 'http' }],
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
      },
    });
    assert.equal(createdJob.status, 202);
    assert.equal(createdJob.body.id, 'job_http_1');

    await waitForJobState(harness, 'job_http_1', JobState.Succeeded);

    const job = await jsonFetch(harness.url('/v1/jobs/job_http_1'));
    assert.equal(job.status, 200);
    assert.equal(job.body.state, JobState.Succeeded);
    assert.equal(job.body.artifactCount, 2);

    const events = await readSse(harness.url('/v1/jobs/job_http_1/events'));
    assert.ok(events.some((event) => event.type === 'job.state'));
    assert.ok(events.some((event) => event.type === 'job.final'));

    const replay = await readSse(harness.url('/v1/jobs/job_http_1/events'), {
      headers: { 'Last-Event-ID': '1' },
    });
    assert.ok(replay.length > 0);
    assert.ok(replay.every((event) => event.sequence > 1));

    const artifacts = await jsonFetch(harness.url('/v1/jobs/job_http_1/artifacts'));
    assert.equal(artifacts.status, 200);
    const valueArtifact = artifacts.body.items.find((item) => item.name === 'value.txt');
    assert.ok(valueArtifact);
    assert.equal(valueArtifact.localPath, undefined);

    const download = await fetch(harness.url(`/v1/artifacts/${valueArtifact.id}/download`));
    assert.equal(download.status, 200);
    assert.equal(await download.text(), 'http');

    const deletedSession = await jsonFetch(harness.url('/v1/sessions/ses_http_1'), {
      method: 'DELETE',
    });
    assert.equal(deletedSession.status, 202);
    assert.equal(deletedSession.body.state, 'deleted');

    const metrics = await fetch(harness.url('/metrics'));
    assert.equal(metrics.status, 200);
    assert.match(await metrics.text(), /partners_gateway_http_requests_total/);
  } finally {
    await harness.close();
  }
});

test('cancels running jobs through HTTP', async () => {
  const metrics = createGatewayMetrics();
  const harness = await startHarness({ metrics });
  try {
    const createdJob = await jsonFetch(harness.url('/v1/jobs'), {
      method: 'POST',
      body: {
        id: 'job_http_cancel_1',
        executionMode: ExecutionMode.EphemeralInterpreter,
        command: {
          argv: [process.execPath, '-e', 'setTimeout(() => console.log("late"), 5000)'],
        },
        timeoutSeconds: 30,
      },
    });
    assert.equal(createdJob.status, 202);

    const cancelled = await jsonFetch(harness.url('/v1/jobs/job_http_cancel_1/cancel'), {
      method: 'POST',
      body: { reason: 'test cancellation' },
    });
    assert.equal(cancelled.status, 202);
    assert.equal(cancelled.body.state, JobState.CancelRequested);

    await waitForJobState(harness, 'job_http_cancel_1', JobState.Cancelled);
    const events = await readSse(harness.url('/v1/jobs/job_http_cancel_1/events'));
    assert.ok(events.some((event) => (
      event.type === 'job.state' && event.state === JobState.CancelRequested
    )));

    await waitForMetrics(
      harness,
      /partners_gateway_jobs_terminal_total\{execution_mode="ephemeral_interpreter",provider="local",state="cancelled"\} 1/,
    );
  } finally {
    await harness.close();
  }
});

test('serves downloads from gateway ArtifactStore manifests', async () => {
  const artifactRoot = await mkdtemp(path.join(tmpdir(), 'partners-http-artifacts-'));
  const harness = await startHarness({
    artifactStore: new LocalArtifactStore({ rootDir: artifactRoot }),
  });
  try {
    const createdJob = await jsonFetch(harness.url('/v1/jobs'), {
      method: 'POST',
      body: {
        id: 'job_http_artifact_store_1',
        executionMode: ExecutionMode.EphemeralInterpreter,
        inputs: {
          files: [{ path: '/workspace/input.txt', content: 'stored artifact' }],
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
      },
    });
    assert.equal(createdJob.status, 202);

    await waitForJobState(harness, 'job_http_artifact_store_1', JobState.Succeeded);

    const artifacts = await jsonFetch(harness.url('/v1/jobs/job_http_artifact_store_1/artifacts'));
    assert.equal(artifacts.status, 200);
    const valueArtifact = artifacts.body.items.find((item) => item.name === 'value.txt');
    assert.ok(valueArtifact);
    assert.equal(valueArtifact.localPath, undefined);
    assert.equal(valueArtifact.storageUri, `artifact://local/${valueArtifact.id}`);
    assert.equal(valueArtifact.downloadHandle, `artifact://local/${valueArtifact.id}`);

    const download = await fetch(harness.url(`/v1/artifacts/${valueArtifact.id}/download`));
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-type'), 'application/octet-stream');
    assert.equal(await download.text(), 'stored artifact');
  } finally {
    await harness.close();
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test('returns validation errors when HTTP jobs are not accepted', async () => {
  const harness = await startHarness();
  try {
    const rejected = await jsonFetch(harness.url('/v1/jobs'), {
      method: 'POST',
      body: {
        id: 'job_http_invalid_1',
        executionMode: ExecutionMode.EphemeralInterpreter,
        timeoutSeconds: 30,
      },
    });

    assert.equal(rejected.status, 400);
    assert.match(rejected.body.error, /requires command or code/);

    const job = await jsonFetch(harness.url('/v1/jobs/job_http_invalid_1'));
    assert.equal(job.status, 404);
  } finally {
    await harness.close();
  }
});

test('accepts the shared sandbox contract over HTTP and exposes only safe references', async () => {
  const harness = await startHarness();
  try {
    const sandbox = {
      profile: 'node-tools',
      image: `registry.example/partners/node@sha256:${'a'.repeat(64)}`,
      imagePullSecretRef: 'platform://registry/partners',
      init: {
        files: [{ path: '/workspace/bootstrap.sh', content: '#!/bin/sh\n' }],
        argv: ['/workspace/bootstrap.sh'],
        timeoutSeconds: 10,
        idempotencyKey: 'http-bootstrap-v1',
      },
    };
    const accepted = await jsonFetch(harness.url('/v1/jobs'), {
      method: 'POST',
      body: {
        id: 'job_http_sandbox_contract',
        executionMode: ExecutionMode.EphemeralInterpreter,
        command: { argv: [process.execPath, '-e', 'console.log("contract")'] },
        timeoutSeconds: 30,
        sandbox,
      },
    });
    assert.equal(accepted.status, 202);
    assert.deepEqual(accepted.body.sandbox, sandbox);
    await waitForJobState(harness, 'job_http_sandbox_contract', JobState.Succeeded);

    const fetched = await jsonFetch(harness.url('/v1/jobs/job_http_sandbox_contract'));
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.sandbox.imagePullSecretRef, 'platform://registry/partners');
    assert.doesNotMatch(JSON.stringify(fetched.body), /BEGIN .*PRIVATE KEY|ghp_/);
  } finally {
    await harness.close();
  }
});

test('waits for explicit HTTP job ids to become visible in async stores', async () => {
  const provider = createCountingProvider();
  const harness = await startHarness({
    provider,
    store: new SlowSaveJobStore(),
  });
  try {
    const accepted = await jsonFetch(harness.url('/v1/jobs'), {
      method: 'POST',
      body: {
        id: 'job_http_slow_store_1',
        executionMode: ExecutionMode.EphemeralInterpreter,
        tenantId: 'tenant_1',
        projectId: 'project_1',
        command: { argv: [process.execPath, '-e', 'console.log("slow-store")'] },
        timeoutSeconds: 30,
      },
    });

    assert.equal(accepted.status, 202);
    assert.equal(accepted.body.id, 'job_http_slow_store_1');
    await waitForJobState(harness, 'job_http_slow_store_1', JobState.Succeeded);
    assert.equal(provider.runCount(), 1);
  } finally {
    await harness.close();
  }
});

test('exposes job success, failure, runtime, and pool metrics over HTTP', async () => {
  const metrics = createGatewayMetrics({
    storeStats: () => ({
      totalCount: 3,
      idleCount: 1,
      waitingCount: 2,
    }),
  });
  const provider = createCountingProvider();
  const harness = await startHarness({ provider, metrics });
  try {
    const succeeded = await jsonFetch(harness.url('/v1/jobs'), {
      method: 'POST',
      body: {
        id: 'job_http_metrics_success_1',
        executionMode: ExecutionMode.EphemeralInterpreter,
        command: { argv: [process.execPath, '-e', 'console.log("metrics")'] },
        timeoutSeconds: 30,
      },
    });
    assert.equal(succeeded.status, 202);
    await waitForJobState(harness, 'job_http_metrics_success_1', JobState.Succeeded);

    const text = await (await fetch(harness.url('/metrics'))).text();
    assert.match(
      text,
      /partners_gateway_jobs_terminal_total\{execution_mode="ephemeral_interpreter",provider="fake",state="succeeded"\} 1/,
    );
    assert.match(
      text,
      /partners_gateway_provider_runtime_duration_ms_count\{execution_mode="ephemeral_interpreter",provider="fake",state="succeeded"\} 1/,
    );
    assert.match(text, /partners_gateway_postgres_pool_total 3/);
    assert.match(text, /partners_gateway_postgres_pool_idle 1/);
    assert.match(text, /partners_gateway_postgres_pool_waiting 2/);
  } finally {
    await harness.close();
  }

  const failingMetrics = createGatewayMetrics();
  const failingHarness = await startHarness({
    metrics: failingMetrics,
    provider: {
      name: 'failing-provider',
      runJob: async () => {
        throw new Error('provider failed');
      },
    },
  });
  try {
    const accepted = await jsonFetch(failingHarness.url('/v1/jobs'), {
      method: 'POST',
      body: {
        id: 'job_http_metrics_failed_1',
        executionMode: ExecutionMode.EphemeralInterpreter,
        command: { argv: [process.execPath, '-e', 'console.log("fail")'] },
        timeoutSeconds: 30,
      },
    });
    assert.equal(accepted.status, 202);
    await waitForJobState(failingHarness, 'job_http_metrics_failed_1', JobState.Failed);

    assert.match(
      await (await fetch(failingHarness.url('/metrics'))).text(),
      /partners_gateway_jobs_terminal_total\{execution_mode="ephemeral_interpreter",provider="failing-provider",state="failed"\} 1/,
    );
  } finally {
    await failingHarness.close();
  }
});

test('enforces service token scopes and tenant/project bounds over HTTP', async () => {
  const harness = await startHarness({
    authorizer: new GatewayServiceAuthorizer({
      clock: () => new Date('2026-07-05T00:00:00.000Z'),
      tokens: [{
        token: 'service-token',
        tokenRef: 'tok_task_weaver',
        actor: 'task-weaver',
        scopes: ['jobs:create', 'jobs:read', 'artifacts:read'],
        tenantIds: ['tenant_1'],
        projectIds: ['project_1'],
        expiresAt: '2026-07-06T00:00:00.000Z',
      }],
    }),
  });
  try {
    const missing = await jsonFetch(harness.url('/v1/jobs/job_missing_auth'));
    assert.equal(missing.status, 404);

    const forbidden = await jsonFetch(harness.url('/v1/jobs'), {
      method: 'POST',
      headers: { authorization: 'Bearer service-token' },
      body: {
        id: 'job_http_forbidden_tenant',
        tenantId: 'tenant_2',
        projectId: 'project_1',
        executionMode: ExecutionMode.EphemeralInterpreter,
        command: { argv: [process.execPath, '-e', 'console.log(1)'] },
        timeoutSeconds: 30,
      },
    });
    assert.equal(forbidden.status, 403);

    const accepted = await jsonFetch(harness.url('/v1/jobs'), {
      method: 'POST',
      headers: { authorization: 'Bearer service-token' },
      body: {
        id: 'job_http_auth_1',
        tenantId: 'tenant_1',
        projectId: 'project_1',
        executionMode: ExecutionMode.EphemeralInterpreter,
        command: { argv: [process.execPath, '-e', 'console.log("auth")'] },
        timeoutSeconds: 30,
      },
    });
    assert.equal(accepted.status, 202);
    assert.equal(accepted.body.tenantId, 'tenant_1');
    assert.equal(accepted.body.projectId, 'project_1');
    assert.equal(accepted.body.actor, 'task-weaver');

    await waitForJobState(harness, 'job_http_auth_1', JobState.Succeeded, {
      authorization: 'Bearer service-token',
    });

    const unauthenticatedRead = await jsonFetch(harness.url('/v1/jobs/job_http_auth_1'));
    assert.equal(unauthenticatedRead.status, 401);

    const missingScope = await jsonFetch(harness.url('/v1/jobs/job_http_auth_1/cancel'), {
      method: 'POST',
      headers: { authorization: 'Bearer service-token' },
      body: { reason: 'not allowed' },
    });
    assert.equal(missingScope.status, 403);
    assert.doesNotMatch(JSON.stringify(missingScope.body), /service-token/);
  } finally {
    await harness.close();
  }
});

test('replays identical POST /v1/jobs requests with Idempotency-Key', async () => {
  const provider = createCountingProvider();
  const harness = await startHarness({ provider });
  try {
    const body = {
      executionMode: ExecutionMode.EphemeralInterpreter,
      tenantId: 'tenant_1',
      projectId: 'project_1',
      command: { argv: [process.execPath, '-e', 'console.log("idem")'] },
      timeoutSeconds: 30,
    };
    const headers = { 'Idempotency-Key': 'tw-task-http-1' };

    const accepted = await jsonFetch(harness.url('/v1/jobs'), {
      method: 'POST',
      headers,
      body,
    });
    const replay = await jsonFetch(harness.url('/v1/jobs'), {
      method: 'POST',
      headers,
      body,
    });

    assert.equal(accepted.status, 202);
    assert.equal(replay.status, 202);
    assert.equal(replay.body.id, accepted.body.id);
    assert.equal(provider.runCount(), 1);
  } finally {
    await harness.close();
  }
});

test('rejects reused Idempotency-Key values with different POST /v1/jobs bodies', async () => {
  const provider = createCountingProvider();
  const harness = await startHarness({ provider });
  try {
    const body = {
      executionMode: ExecutionMode.EphemeralInterpreter,
      tenantId: 'tenant_1',
      projectId: 'project_1',
      command: { argv: [process.execPath, '-e', 'console.log("idem")'] },
      timeoutSeconds: 30,
    };
    const headers = { 'Idempotency-Key': 'tw-task-http-2' };

    const accepted = await jsonFetch(harness.url('/v1/jobs'), {
      method: 'POST',
      headers,
      body,
    });
    const conflict = await jsonFetch(harness.url('/v1/jobs'), {
      method: 'POST',
      headers,
      body: { ...body, timeoutSeconds: 60 },
    });

    assert.equal(accepted.status, 202);
    assert.equal(conflict.status, 409);
    assert.match(conflict.body.error, /different request body/);
    assert.equal(provider.runCount(), 1);
  } finally {
    await harness.close();
  }
});

test('rejects invalid Idempotency-Key headers before creating HTTP jobs', async () => {
  const provider = createCountingProvider();
  const harness = await startHarness({ provider });
  try {
    const rejected = await jsonFetch(harness.url('/v1/jobs'), {
      method: 'POST',
      headers: { 'Idempotency-Key': 'bad key 123' },
      body: {
        executionMode: ExecutionMode.EphemeralInterpreter,
        tenantId: 'tenant_1',
        projectId: 'project_1',
        command: { argv: [process.execPath, '-e', 'console.log("bad-key")'] },
        timeoutSeconds: 30,
      },
    });

    assert.equal(rejected.status, 400);
    assert.match(rejected.body.error, /unsupported characters/);
    assert.equal(provider.runCount(), 0);
  } finally {
    await harness.close();
  }
});

test('scopes Idempotency-Key replay to tenant and project', async () => {
  const provider = createCountingProvider();
  const harness = await startHarness({ provider });
  try {
    const headers = { 'Idempotency-Key': 'tw-task-http-scope-1' };
    const body = {
      executionMode: ExecutionMode.EphemeralInterpreter,
      tenantId: 'tenant_1',
      projectId: 'project_1',
      command: { argv: [process.execPath, '-e', 'console.log("scope")'] },
      timeoutSeconds: 30,
    };

    const first = await jsonFetch(harness.url('/v1/jobs'), {
      method: 'POST',
      headers,
      body,
    });
    const secondProject = await jsonFetch(harness.url('/v1/jobs'), {
      method: 'POST',
      headers,
      body: { ...body, projectId: 'project_2' },
    });

    assert.equal(first.status, 202);
    assert.equal(secondProject.status, 202);
    assert.notEqual(secondProject.body.id, first.body.id);
    assert.equal(provider.runCount(), 2);
  } finally {
    await harness.close();
  }
});

test('preserves non-idempotent POST /v1/jobs behavior when the header is absent', async () => {
  const provider = createCountingProvider();
  const harness = await startHarness({ provider });
  try {
    const body = {
      executionMode: ExecutionMode.EphemeralInterpreter,
      tenantId: 'tenant_1',
      projectId: 'project_1',
      command: { argv: [process.execPath, '-e', 'console.log("plain")'] },
      timeoutSeconds: 30,
    };

    const first = await jsonFetch(harness.url('/v1/jobs'), { method: 'POST', body });
    const second = await jsonFetch(harness.url('/v1/jobs'), { method: 'POST', body });

    assert.equal(first.status, 202);
    assert.equal(second.status, 202);
    assert.notEqual(second.body.id, first.body.id);
    assert.equal(provider.runCount(), 2);
  } finally {
    await harness.close();
  }
});

test('replays POST /v1/jobs idempotency records after gateway restart', async () => {
  const store = new InMemoryGatewayStore();
  const firstProvider = createCountingProvider();
  const firstHarness = await startHarness({ provider: firstProvider, store });
  const body = {
    executionMode: ExecutionMode.EphemeralInterpreter,
    tenantId: 'tenant_1',
    projectId: 'project_1',
    command: { argv: [process.execPath, '-e', 'console.log("restart")'] },
    timeoutSeconds: 30,
  };
  const headers = { 'Idempotency-Key': 'tw-task-http-restart-1' };
  let accepted;
  try {
    accepted = await jsonFetch(firstHarness.url('/v1/jobs'), { method: 'POST', headers, body });
    assert.equal(accepted.status, 202);
  } finally {
    await firstHarness.close();
  }

  const secondProvider = createCountingProvider();
  const secondHarness = await startHarness({ provider: secondProvider, store });
  try {
    const replay = await jsonFetch(secondHarness.url('/v1/jobs'), { method: 'POST', headers, body });

    assert.equal(replay.status, 202);
    assert.equal(replay.body.id, accepted.body.id);
    assert.equal(firstProvider.runCount(), 1);
    assert.equal(secondProvider.runCount(), 0);
  } finally {
    await secondHarness.close();
  }
});

async function startHarness({
  authorizer,
  artifactStore,
  provider = new LocalSandboxProvider(),
  store,
  metrics = createTestMetrics(),
} = {}) {
  const gateway = new InMemoryAgentExecutionGateway({
    provider,
    store,
    artifactStore,
    metrics,
  });
  const app = createAgentExecutionGatewayServer({ gateway, authorizer, metrics });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const { port } = app.server.address();
  return {
    url: (path) => `http://127.0.0.1:${port}${path}`,
    close: app.close,
  };
}

function createCountingProvider() {
  let runCount = 0;
  return {
    name: 'fake',
    runCount: () => runCount,
    runJob: async (request) => {
      runCount += 1;
      return {
        id: request.id,
        state: JobState.Succeeded,
        executionMode: request.executionMode,
        provider: 'fake',
        providerJobId: `provider_${request.id}`,
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
        artifacts: [],
        completedAt: new Date().toISOString(),
      };
    },
  };
}

class SlowSaveJobStore extends InMemoryGatewayStore {
  async saveJob(job) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    return super.saveJob(job);
  }
}

function createTestMetrics() {
  let requests = 0;
  return {
    recordRequest: () => {
      requests += 1;
    },
    prometheus: () => `partners_gateway_http_requests_total ${requests}\n`,
  };
}

async function jsonFetch(url, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return {
    status: response.status,
    body: await response.json(),
  };
}

async function waitForJobState(harness, jobId, state, headers = {}) {
  for (let index = 0; index < 50; index += 1) {
    const job = await jsonFetch(harness.url(`/v1/jobs/${jobId}`), { headers });
    if (job.body.state === state) {
      return job.body;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Job ${jobId} did not reach state ${state}`);
}

async function readSse(url, options = {}) {
  const response = await fetch(url, options);
  assert.equal(response.status, 200);
  const text = await response.text();
  return text
    .trim()
    .split('\n\n')
    .filter(Boolean)
    .map((chunk) => {
      const dataLine = chunk.split('\n').find((line) => line.startsWith('data: '));
      return dataLine ? JSON.parse(dataLine.slice('data: '.length)) : null;
    })
    .filter(Boolean);
}

async function waitForMetrics(harness, regex) {
  for (let index = 0; index < 50; index += 1) {
    const response = await fetch(harness.url('/metrics'));
    if (response.status === 200) {
      const text = await response.text();
      if (regex.test(text)) {
        return text;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const finalResponse = await fetch(harness.url('/metrics'));
  const finalText = await finalResponse.text();
  assert.match(finalText, regex);
}

