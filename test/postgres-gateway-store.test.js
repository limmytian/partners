import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  ExecutionMode,
  createGatewayServiceToken,
  hashGatewayServiceToken,
  InMemoryAgentExecutionGateway,
  JobState,
  PostgresGatewayStore,
  POSTGRES_GATEWAY_SCHEMA,
  PgPoolPostgresRunner,
  rotateGatewayServiceToken,
  updateGatewayServiceToken,
} from '../src/index.js';

test('maps GatewayStore operations to Postgres tables without raw service tokens', async () => {
  const runner = new RecordingPostgresRunner();
  const store = new PostgresGatewayStore({
    connectionString: 'postgres://example',
    runner,
  });

  await store.migrate();
  assert.match(runner.calls[0].statements[0].sql, /CREATE TABLE IF NOT EXISTS gateway_jobs/);
  assert.match(POSTGRES_GATEWAY_SCHEMA, /gateway_audit_records/);

  assert.equal(await store.nextEventSequence(), 1);

  const job = await store.saveJob({
    id: 'job_pg_1',
    state: JobState.Queued,
    executionMode: ExecutionMode.EphemeralInterpreter,
    provider: 'fake',
    artifactCount: 0,
    createdAt: '2026-07-05T00:00:00.000Z',
    updatedAt: '2026-07-05T00:00:00.000Z',
  });
  assert.equal(job.id, 'job_pg_1');

  await store.appendEvent('job_pg_1', {
    id: 'evt_pg_1',
    jobId: 'job_pg_1',
    sequence: 1,
    type: 'job.state',
    state: JobState.Queued,
    at: '2026-07-05T00:00:00.000Z',
  });
  assert.equal((await store.listJobEvents('job_pg_1'))[0].type, 'job.state');

  await store.saveArtifact('job_pg_1', {
    id: 'art_pg_1',
    jobId: 'job_pg_1',
    kind: 'file',
    name: 'result.txt',
    storageUri: 'artifact://local/art_pg_1',
    sizeBytes: 6,
    createdAt: '2026-07-05T00:00:00.000Z',
  });
  assert.equal((await store.getArtifact('art_pg_1')).name, 'result.txt');
  assert.equal((await store.listArtifactManifests()).length, 1);
  assert.equal((await store.deleteArtifactManifest('art_pg_1')).id, 'art_pg_1');
  assert.equal(await store.getArtifact('art_pg_1'), null);

  await store.recordCancellation('job_pg_1', {
    reason: 'operator stop',
    requestedAt: '2026-07-05T00:00:01.000Z',
  });
  assert.equal((await store.getCancellation('job_pg_1')).reason, 'operator stop');

  await store.saveIdempotencyKey('tenant:req:abc', {
    scope: 'jobs:create',
    requestHash: 'hash_1',
    resourceType: 'job',
    resourceId: 'job_pg_1',
    statusCode: 202,
    responseBody: { id: 'job_pg_1', state: JobState.Queued },
    createdAt: '2026-07-05T00:00:00.000Z',
    expiresAt: '2026-07-06T00:00:00.000Z',
  });
  assert.equal((await store.getIdempotencyKey('tenant:req:abc')).resourceId, 'job_pg_1');
  assert.deepEqual((await store.getIdempotencyKey('tenant:req:abc')).responseBody, {
    id: 'job_pg_1',
    state: JobState.Queued,
  });

  const token = await store.saveServiceToken({
    token: 'raw-secret-token',
    tokenRef: 'tok_pg_1',
    actor: 'task-weaver',
    scopes: ['jobs:create'],
    tenantIds: ['tenant_1'],
    projectIds: ['project_1'],
  });
  assert.equal(token.tokenHash, hashGatewayServiceToken('raw-secret-token'));
  assert.equal((await store.getServiceTokenByHash(token.tokenHash)).tokenRef, 'tok_pg_1');
  assert.doesNotMatch(JSON.stringify(runner.calls), /raw-secret-token/);

  await store.recordAudit({
    action: 'authorize',
    scope: 'jobs:create',
    tokenRef: 'tok_pg_1',
    actor: 'task-weaver',
    tenantId: 'tenant_1',
    projectId: 'project_1',
    outcome: 'accepted',
  });
  assert.equal((await store.listAuditRecords({ tokenRef: 'tok_pg_1' }))[0].outcome, 'accepted');
});

test('persists gateway records against live Postgres when POSTGRES_URL is set', {
  skip: !process.env.POSTGRES_URL,
}, async () => {
  const suffix = randomUUID();
  const store = new PostgresGatewayStore();
  await store.migrate();

  const gateway = new InMemoryAgentExecutionGateway({
    store,
    provider: {
      name: 'fake',
      runJob: async (_request, onEvent) => {
        onEvent({
          type: 'artifact.created',
          artifact: {
            id: `art_live_${suffix}`,
            kind: 'file',
            name: 'result.txt',
            storageUri: `artifact://local/art_live_${suffix}`,
            sizeBytes: 6,
            createdAt: '2026-07-05T00:00:00.000Z',
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
          completedAt: '2026-07-05T00:00:01.000Z',
        };
      },
      cancel: async () => {},
    },
  });

  await gateway.runJob({
    id: `job_live_${suffix}`,
    executionMode: ExecutionMode.EphemeralInterpreter,
    command: { argv: ['echo', 'stored'] },
    timeoutSeconds: 30,
  });

  const reloaded = new PostgresGatewayStore();
  assert.equal((await reloaded.getJob(`job_live_${suffix}`)).state, JobState.Succeeded);
  assert.equal((await reloaded.listJobEvents(`job_live_${suffix}`)).length, 2);
  assert.equal((await reloaded.getArtifact(`art_live_${suffix}`)).name, 'result.txt');
  await store.close();
  await reloaded.close();
});

test('executes Postgres statements through a pooled runner with health and error metadata', async () => {
  const pool = new FakePgPool();
  const runner = new PgPoolPostgresRunner({ pool, queryTimeoutMs: 1234 });

  const response = await runner.execute({
    statements: [{
      name: 'selectOne',
      sql: 'SELECT $1::int AS value',
      values: [1],
    }],
  });

  assert.deepEqual(response.results[0].rows, [{ ok: 1 }]);
  assert.equal(pool.queries[0].query_timeout, 1234);
  assert.equal(pool.releaseCount, 1);

  const health = await runner.healthCheck();
  assert.equal(health.status, 'ready');
  assert.deepEqual(health.pool, { totalCount: 2, idleCount: 1, waitingCount: 0 });

  pool.failNextQuery = true;
  await assert.rejects(() => runner.execute({
    statements: [{
      name: 'brokenStatement',
      sql: 'SELECT broken',
    }],
  }), /PostgresGatewayStore query failed in brokenStatement: simulated query failure/);
  assert.equal(pool.releaseCount, 2);
});

test('manages service token lifecycle without persisting raw token values', async () => {
  const runner = new RecordingPostgresRunner();
  const store = new PostgresGatewayStore({
    connectionString: 'postgres://example',
    runner,
  });
  const context = {
    operator: 'ops-admin',
    now: () => '2026-07-05T00:00:00.000Z',
    generateToken: () => 'raw-created-token',
  };

  const created = await createGatewayServiceToken(store, {
    tokenRef: 'tok_ops_1',
    actor: 'task-weaver',
    scopes: ['jobs:create', 'jobs:read'],
    tenantIds: ['tenant_1'],
    projectIds: ['project_1'],
    expiresAt: '2026-07-06T00:00:00.000Z',
  }, context);

  assert.equal(created.tokenValue, 'raw-created-token');
  assert.equal(created.token.tokenHash, undefined);
  assert.equal((await store.getServiceToken('tok_ops_1')).tokenRef, 'tok_ops_1');
  assert.equal((await store.listServiceTokens()).length, 1);
  assert.doesNotMatch(JSON.stringify(runner.calls), /raw-created-token/);

  const updated = await updateGatewayServiceToken(store, {
    tokenRef: 'tok_ops_1',
    scopes: ['jobs:create', 'jobs:read', 'artifacts:read'],
    expiresAt: 'null',
    metadata: { owner: 'platform' },
  }, context);
  assert.equal(updated.expiresAt, null);
  assert.deepEqual(updated.scopes, ['jobs:create', 'jobs:read', 'artifacts:read']);

  const rotated = await rotateGatewayServiceToken(store, {
    tokenRef: 'tok_ops_1',
    newTokenRef: 'tok_ops_2',
    revokeOld: true,
  }, {
    ...context,
    generateToken: () => 'raw-rotated-token',
  });
  assert.equal(rotated.tokenValue, 'raw-rotated-token');
  assert.equal(rotated.revoked.tokenRef, 'tok_ops_1');
  assert.equal(await store.getServiceTokenByHash(hashGatewayServiceToken('raw-created-token')), null);
  assert.equal(
    (await store.getServiceTokenByHash(hashGatewayServiceToken('raw-rotated-token'))).tokenRef,
    'tok_ops_2',
  );

  const auditActions = (await store.listAuditRecords({ tokenRef: 'tok_ops_2' }))
    .map((record) => record.action);
  assert.deepEqual(auditActions, ['token.rotate']);
  assert.doesNotMatch(JSON.stringify(runner.calls), /raw-rotated-token/);
});


class RecordingPostgresRunner {
  constructor() {
    this.calls = [];
    this.sequence = 0;
    this.sessions = new Map();
    this.jobs = new Map();
    this.events = new Map();
    this.artifacts = new Map();
    this.cancellations = new Map();
    this.idempotencyKeys = new Map();
    this.serviceTokens = new Map();
    this.auditRecords = [];
  }

  execute(payload) {
    this.calls.push(payload);
    return {
      results: payload.statements.map((statement) => this.#handle(statement)),
    };
  }

  #handle(statement) {
    switch (statement.name) {
      case 'migrate':
        return { rows: [], rowCount: 0 };
      case 'nextEventSequence':
        this.sequence += 1;
        return { rows: [{ sequence: this.sequence }], rowCount: 1 };
      case 'saveSession':
        return this.#saveRecord(this.sessions, statement.values[0], statement.values[8]);
      case 'getSession':
        return this.#getRecord(this.sessions, statement.values[0]);
      case 'saveJob':
        return this.#saveRecord(this.jobs, statement.values[0], statement.values[14]);
      case 'getJob':
        return this.#getRecord(this.jobs, statement.values[0]);
      case 'listJobs':
        return { rows: [...this.jobs.values()].map((record) => ({ record })), rowCount: this.jobs.size };
      case 'appendEvent': {
        const record = JSON.parse(statement.values[7]);
        const bucket = this.events.get(statement.values[1]) ?? [];
        bucket.push(record);
        this.events.set(statement.values[1], bucket);
        return { rows: [{ record }], rowCount: 1 };
      }
      case 'listJobEvents': {
        const rows = (this.events.get(statement.values[0]) ?? [])
          .filter((event) => event.sequence > statement.values[1])
          .map((record) => ({ record }));
        return { rows, rowCount: rows.length };
      }
      case 'saveArtifact':
        return this.#saveRecord(this.artifacts, statement.values[0], statement.values[12]);
      case 'listJobArtifacts': {
        const rows = [...this.artifacts.values()]
          .filter((record) => record.jobId === statement.values[0])
          .map((record) => ({ record }));
        return { rows, rowCount: rows.length };
      }
      case 'getArtifact':
        return this.#getRecord(this.artifacts, statement.values[0]);
      case 'listArtifactManifests': {
        const rows = [...this.artifacts.values()].map((record) => ({ record }));
        return { rows, rowCount: rows.length };
      }
      case 'deleteArtifactManifest': {
        const record = this.artifacts.get(statement.values[0]);
        this.artifacts.delete(statement.values[0]);
        return { rows: record ? [{ record }] : [], rowCount: record ? 1 : 0 };
      }
      case 'recordCancellation':
        return this.#saveRecord(this.cancellations, statement.values[0], statement.values[5]);
      case 'getCancellation':
        return this.#getRecord(this.cancellations, statement.values[0]);
      case 'saveIdempotencyKey':
        return this.#saveRecord(this.idempotencyKeys, statement.values[0], statement.values[10]);
      case 'getIdempotencyKey':
        return this.#getRecord(this.idempotencyKeys, statement.values[0]);
      case 'saveServiceToken': {
        const row = {
          token_ref: statement.values[0],
          token_hash: statement.values[1],
          actor: statement.values[2],
          scopes: statement.values[3],
          tenant_ids: statement.values[4],
          project_ids: statement.values[5],
          expires_at: statement.values[6],
          revoked_at: statement.values[7],
          metadata: JSON.parse(statement.values[8]),
          created_at: statement.values[9],
          updated_at: statement.values[10],
        };
        this.serviceTokens.set(row.token_ref, row);
        return { rows: [row], rowCount: 1 };
      }
      case 'getServiceTokenByHash': {
        const row = [...this.serviceTokens.values()]
          .find((candidate) => (
            candidate.token_hash === statement.values[0]
            && !candidate.revoked_at
          ));
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      case 'getServiceToken': {
        const row = this.serviceTokens.get(statement.values[0]);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      case 'listServiceTokens': {
        const includeRevoked = !/WHERE revoked_at IS NULL/.test(statement.sql);
        const rows = [...this.serviceTokens.values()]
          .filter((row) => includeRevoked || !row.revoked_at)
          .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)));
        return { rows, rowCount: rows.length };
      }
      case 'revokeServiceToken': {
        const row = this.serviceTokens.get(statement.values[0]);
        if (!row) {
          return { rows: [], rowCount: 0 };
        }
        row.revoked_at = statement.values[1];
        row.metadata = {
          ...row.metadata,
          ...JSON.parse(statement.values[2]),
        };
        row.updated_at = statement.values[3];
        return { rows: [row], rowCount: 1 };
      }
      case 'recordAudit': {
        const row = {
          id: statement.values[0],
          action: statement.values[1],
          scope: statement.values[2],
          token_ref: statement.values[3],
          actor: statement.values[4],
          tenant_id: statement.values[5],
          project_id: statement.values[6],
          resource_type: statement.values[7],
          resource_id: statement.values[8],
          outcome: statement.values[9],
          reason: statement.values[10],
          metadata: JSON.parse(statement.values[11]),
          at: statement.values[12],
        };
        this.auditRecords.push(row);
        return { rows: [row], rowCount: 1 };
      }
      case 'listAuditRecords': {
        const tokenRef = statement.values.length === 2 ? statement.values[0] : null;
        const rows = this.auditRecords
          .filter((row) => !tokenRef || row.token_ref === tokenRef)
          .map((row) => row);
        return { rows, rowCount: rows.length };
      }
      default:
        throw new Error(`Unhandled statement: ${statement.name}`);
    }
  }

  #saveRecord(map, key, rawRecord) {
    const record = JSON.parse(rawRecord);
    map.set(key, record);
    return { rows: [{ record }], rowCount: 1 };
  }

  #getRecord(map, key) {
    const record = map.get(key);
    return { rows: record ? [{ record }] : [], rowCount: record ? 1 : 0 };
  }
}

class FakePgPool {
  constructor() {
    this.totalCount = 2;
    this.idleCount = 1;
    this.waitingCount = 0;
    this.queries = [];
    this.releaseCount = 0;
    this.failNextQuery = false;
  }

  async connect() {
    return {
      query: async (query) => {
        this.queries.push(query);
        if (this.failNextQuery) {
          this.failNextQuery = false;
          throw new Error('simulated query failure');
        }
        return { rows: [{ ok: 1 }], rowCount: 1 };
      },
      release: () => {
        this.releaseCount += 1;
      },
    };
  }

  async query(sql) {
    this.healthSql = sql;
    return { rows: [{ ok: 1 }], rowCount: 1 };
  }
}
