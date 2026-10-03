import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ExecutionMode,
  IdempotencyScope,
  InMemoryAgentExecutionGateway,
  JobState,
  createIdempotencyContext,
  createJobIdempotencyRecord,
  isIdempotencyRecordExpired,
} from '../src/index.js';

test('builds stable idempotency hashes with tenant/project scope isolation', () => {
  const base = {
    idempotencyKey: 'tw-task-abc-1',
    scope: IdempotencyScope.JobsCreate,
    request: {
      projectId: 'project_1',
      tenantId: 'tenant_1',
      timeoutSeconds: 30,
      executionMode: ExecutionMode.EphemeralInterpreter,
      command: { cwd: '/workspace', argv: ['node', '-e', 'console.log(1)'] },
    },
    now: '2026-07-05T00:00:00.000Z',
  };

  const first = createIdempotencyContext(base);
  const reordered = createIdempotencyContext({
    ...base,
    request: {
      command: { argv: ['node', '-e', 'console.log(1)'], cwd: '/workspace' },
      executionMode: ExecutionMode.EphemeralInterpreter,
      timeoutSeconds: 30,
      tenantId: 'tenant_1',
      projectId: 'project_1',
    },
  });
  const otherProject = createIdempotencyContext({
    ...base,
    request: { ...base.request, projectId: 'project_2' },
  });

  assert.equal(first.requestHash, reordered.requestHash);
  assert.notEqual(first.storeKey, otherProject.storeKey);
  assert.notEqual(first.requestHash, otherProject.requestHash);
});

test('redacts secret-shaped request fields before idempotency hashing', () => {
  const shared = {
    idempotencyKey: 'tw-task-secret-1',
    scope: IdempotencyScope.JobsCreate,
    now: '2026-07-05T00:00:00.000Z',
  };
  const first = createIdempotencyContext({
    ...shared,
    request: {
      tenantId: 'tenant_1',
      projectId: 'project_1',
      executionMode: ExecutionMode.EphemeralInterpreter,
      command: { argv: ['node', '-e', 'console.log(process.env.SECRET)'] },
      timeoutSeconds: 30,
      inlineSecrets: { API_TOKEN: 'first-secret' },
    },
  });
  const second = createIdempotencyContext({
    ...shared,
    request: {
      tenantId: 'tenant_1',
      projectId: 'project_1',
      executionMode: ExecutionMode.EphemeralInterpreter,
      command: { argv: ['node', '-e', 'console.log(process.env.SECRET)'] },
      timeoutSeconds: 30,
      inlineSecrets: { API_TOKEN: 'second-secret' },
    },
  });

  assert.equal(first.requestHash, second.requestHash);
});

test('excludes gateway-auth metadata from idempotency request hashes', () => {
  const request = {
    tenantId: 'tenant_1',
    projectId: 'project_1',
    executionMode: ExecutionMode.EphemeralInterpreter,
    command: { argv: ['node', '-e', 'console.log(1)'] },
    timeoutSeconds: 30,
    metadata: { userValue: 'kept' },
  };
  const beforeAuth = createIdempotencyContext({
    idempotencyKey: 'tw-task-auth-1',
    scope: IdempotencyScope.JobsCreate,
    request,
    now: '2026-07-05T00:00:00.000Z',
  });
  const afterAuth = createIdempotencyContext({
    idempotencyKey: 'tw-task-auth-1',
    scope: IdempotencyScope.JobsCreate,
    request: {
      ...request,
      metadata: {
        ...request.metadata,
        gatewayAuth: {
          tokenRef: 'tok_task_weaver',
          actor: 'task-weaver',
        },
      },
    },
    now: '2026-07-05T00:00:00.000Z',
  });

  assert.equal(beforeAuth.requestHash, afterAuth.requestHash);
});

test('creates job idempotency records with response envelopes and TTL', () => {
  const { storeKey, record } = createJobIdempotencyRecord({
    idempotencyKey: 'tw-task-job-1',
    request: {
      tenantId: 'tenant_1',
      projectId: 'project_1',
      executionMode: ExecutionMode.EphemeralInterpreter,
      command: { argv: ['node', '-e', 'console.log(1)'] },
      timeoutSeconds: 30,
    },
    responseBody: { id: 'job_idem_1', state: JobState.Queued },
    now: '2026-07-05T00:00:00.000Z',
    ttlSeconds: 60,
  });

  assert.match(storeKey, /^idem_[a-f0-9]{64}$/);
  assert.equal(record.resourceType, 'job');
  assert.equal(record.resourceId, 'job_idem_1');
  assert.equal(record.statusCode, 202);
  assert.deepEqual(record.responseBody, { id: 'job_idem_1', state: JobState.Queued });
  assert.equal(isIdempotencyRecordExpired(record, '2026-07-05T00:00:59.000Z'), false);
  assert.equal(isIdempotencyRecordExpired(record, '2026-07-05T00:01:00.000Z'), true);
});

test('gateway saves and compares job idempotency records through the configured store', async () => {
  const gateway = new InMemoryAgentExecutionGateway({
    clock: () => new Date('2026-07-05T00:00:00.000Z'),
    provider: {
      name: 'fake',
      runJob: async () => ({
        state: JobState.Succeeded,
        executionMode: ExecutionMode.EphemeralInterpreter,
        provider: 'fake',
        exitCode: 0,
        stdout: '',
        stderr: '',
        artifacts: [],
        completedAt: '2026-07-05T00:00:01.000Z',
      }),
    },
  });
  const request = {
    id: 'job_idem_gateway_1',
    tenantId: 'tenant_1',
    projectId: 'project_1',
    executionMode: ExecutionMode.EphemeralInterpreter,
    command: { argv: ['node', '-e', 'console.log(1)'] },
    timeoutSeconds: 30,
  };
  const responseBody = { id: 'job_idem_gateway_1', state: JobState.Queued };

  const saved = await gateway.saveJobIdempotencyRecord({
    idempotencyKey: 'tw-task-gateway-1',
    request,
    responseBody,
  });
  const replay = await gateway.getJobIdempotencyRecord({
    idempotencyKey: 'tw-task-gateway-1',
    request,
  });
  const conflict = await gateway.getJobIdempotencyRecord({
    idempotencyKey: 'tw-task-gateway-1',
    request: { ...request, timeoutSeconds: 60 },
  });
  const otherScope = await gateway.getJobIdempotencyRecord({
    idempotencyKey: 'tw-task-gateway-1',
    request: { ...request, projectId: 'project_2' },
  });

  assert.equal(saved.resourceId, 'job_idem_gateway_1');
  assert.equal(replay.matchesRequest, true);
  assert.equal(replay.responseBody.id, 'job_idem_gateway_1');
  assert.equal(conflict.matchesRequest, false);
  assert.equal(otherScope, null);
});
