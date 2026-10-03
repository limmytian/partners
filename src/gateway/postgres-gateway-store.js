import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

import { hashGatewayServiceToken } from '../security/gateway-service-auth.js';

export const POSTGRES_GATEWAY_SCHEMA = `
CREATE SEQUENCE IF NOT EXISTS gateway_event_sequence;

CREATE TABLE IF NOT EXISTS gateway_sessions (
  id text PRIMARY KEY,
  tenant_id text,
  project_id text,
  state text NOT NULL,
  provider text,
  provider_session_id text,
  actor text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  record jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS gateway_jobs (
  id text PRIMARY KEY,
  tenant_id text,
  project_id text,
  session_id text,
  state text NOT NULL,
  execution_mode text NOT NULL,
  provider text,
  provider_job_id text,
  timeout_seconds integer,
  exit_code integer,
  terminal_reason text,
  artifact_count integer NOT NULL DEFAULT 0,
  actor text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  record jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS gateway_job_events (
  id text PRIMARY KEY,
  job_id text NOT NULL REFERENCES gateway_jobs(id) ON DELETE CASCADE,
  sequence bigint NOT NULL,
  type text NOT NULL,
  provider text,
  at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  record jsonb NOT NULL,
  UNIQUE (job_id, sequence)
);

CREATE TABLE IF NOT EXISTS gateway_artifacts (
  id text PRIMARY KEY,
  job_id text NOT NULL REFERENCES gateway_jobs(id) ON DELETE CASCADE,
  kind text NOT NULL,
  name text NOT NULL,
  storage_uri text,
  download_handle text,
  download_url text,
  content_type text,
  size_bytes bigint,
  sha256 text,
  retention_class text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  record jsonb NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS gateway_cancellations (
  job_id text PRIMARY KEY REFERENCES gateway_jobs(id) ON DELETE CASCADE,
  reason text NOT NULL,
  requested_by text,
  requested_at timestamptz NOT NULL,
  provider_ack_at timestamptz,
  record jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS gateway_idempotency_keys (
  key text PRIMARY KEY,
  tenant_id text,
  scope text NOT NULL,
  request_hash text NOT NULL,
  resource_type text,
  resource_id text,
  status_code integer,
  response_body jsonb,
  record jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz
);

CREATE TABLE IF NOT EXISTS gateway_service_tokens (
  token_ref text PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  actor text NOT NULL,
  scopes text[] NOT NULL DEFAULT ARRAY[]::text[],
  tenant_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  project_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  expires_at timestamptz,
  revoked_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS gateway_audit_records (
  id text PRIMARY KEY,
  action text NOT NULL,
  scope text,
  token_ref text,
  actor text,
  tenant_id text,
  project_id text,
  resource_type text,
  resource_id text,
  outcome text NOT NULL,
  reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS gateway_jobs_scope_created_idx
  ON gateway_jobs (tenant_id, project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS gateway_jobs_session_created_idx
  ON gateway_jobs (session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS gateway_job_events_job_sequence_idx
  ON gateway_job_events (job_id, sequence);
CREATE INDEX IF NOT EXISTS gateway_artifacts_job_created_idx
  ON gateway_artifacts (job_id, created_at);
CREATE INDEX IF NOT EXISTS gateway_idempotency_scope_idx
  ON gateway_idempotency_keys (tenant_id, scope, key);
CREATE INDEX IF NOT EXISTS gateway_idempotency_expiry_idx
  ON gateway_idempotency_keys (expires_at);
CREATE INDEX IF NOT EXISTS gateway_audit_scope_idx
  ON gateway_audit_records (tenant_id, project_id, at DESC);
CREATE INDEX IF NOT EXISTS gateway_audit_token_idx
  ON gateway_audit_records (token_ref, at DESC);
`;

export class PostgresGatewayStore {
  constructor({
    connectionString = process.env.POSTGRES_URL,
    runner = null,
    pool = null,
    poolOptions = {},
    queryTimeoutMs = parseInteger(process.env.GATEWAY_POSTGRES_QUERY_TIMEOUT_MS, 30000),
  } = {}) {
    if (!connectionString && !runner && !pool) {
      throw new TypeError('PostgresGatewayStore requires connectionString, POSTGRES_URL, runner, or pool');
    }
    this.connectionString = connectionString ?? null;
    this.runner = runner ?? new PgPoolPostgresRunner({
      connectionString,
      pool,
      poolOptions,
      queryTimeoutMs,
    });
  }

  async migrate() {
    await this.#execute([{ name: 'migrate', sql: POSTGRES_GATEWAY_SCHEMA }]);
  }

  async nextEventSequence() {
    const result = await this.#single({
      name: 'nextEventSequence',
      sql: "SELECT nextval('gateway_event_sequence')::bigint AS sequence",
    });
    return Number(result.rows[0].sequence);
  }

  async saveSession(session) {
    const record = clone(session);
    const result = await this.#single({
      name: 'saveSession',
      sql: `
        INSERT INTO gateway_sessions (
          id, tenant_id, project_id, state, provider, provider_session_id, actor,
          metadata, record, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::timestamptz, $11::timestamptz)
        ON CONFLICT (id) DO UPDATE SET
          tenant_id = EXCLUDED.tenant_id,
          project_id = EXCLUDED.project_id,
          state = EXCLUDED.state,
          provider = EXCLUDED.provider,
          provider_session_id = EXCLUDED.provider_session_id,
          actor = EXCLUDED.actor,
          metadata = EXCLUDED.metadata,
          record = EXCLUDED.record,
          updated_at = EXCLUDED.updated_at
        RETURNING record
      `,
      values: [
        record.id,
        record.tenantId ?? null,
        record.projectId ?? null,
        record.state,
        record.provider ?? null,
        record.providerSessionId ?? null,
        record.actor ?? null,
        json(record.metadata ?? {}),
        json(record),
        timestamp(record.createdAt),
        timestamp(record.updatedAt),
      ],
    });
    return clone(result.rows[0].record);
  }

  async getSession(sessionId) {
    return this.#recordOrNull({
      name: 'getSession',
      sql: 'SELECT record FROM gateway_sessions WHERE id = $1',
      values: [sessionId],
    });
  }

  async listSessions({ tenantId, projectId, state, limit = 50, offset = 0 } = {}) {
    const conditions = [];
    const values = [];
    if (tenantId) {
      values.push(tenantId);
      conditions.push(`tenant_id = $${values.length}`);
    }
    if (projectId) {
      values.push(projectId);
      conditions.push(`project_id = $${values.length}`);
    }
    if (state) {
      values.push(state);
      conditions.push(`state = $${values.length}`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    values.push(limit);
    const limitIdx = values.length;
    values.push(offset);
    const offsetIdx = values.length;
    const result = await this.#single({
      name: 'listSessions',
      sql: `
        SELECT record
        FROM gateway_sessions
        ${where}
        ORDER BY created_at DESC
        LIMIT $${limitIdx} OFFSET $${offsetIdx}
      `,
      values,
    });
    return result.rows.map((row) => clone(row.record));
  }

  async saveJob(job) {
    const record = clone(job);
    const result = await this.#single({
      name: 'saveJob',
      sql: `
        INSERT INTO gateway_jobs (
          id, tenant_id, project_id, session_id, state, execution_mode, provider,
          provider_job_id, timeout_seconds, exit_code, terminal_reason,
          artifact_count, actor, metadata, record, created_at, updated_at,
          completed_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
          $12, $13, $14::jsonb, $15::jsonb, $16::timestamptz,
          $17::timestamptz, $18::timestamptz
        )
        ON CONFLICT (id) DO UPDATE SET
          tenant_id = EXCLUDED.tenant_id,
          project_id = EXCLUDED.project_id,
          session_id = EXCLUDED.session_id,
          state = EXCLUDED.state,
          execution_mode = EXCLUDED.execution_mode,
          provider = EXCLUDED.provider,
          provider_job_id = EXCLUDED.provider_job_id,
          timeout_seconds = EXCLUDED.timeout_seconds,
          exit_code = EXCLUDED.exit_code,
          terminal_reason = EXCLUDED.terminal_reason,
          artifact_count = EXCLUDED.artifact_count,
          actor = EXCLUDED.actor,
          metadata = EXCLUDED.metadata,
          record = EXCLUDED.record,
          updated_at = EXCLUDED.updated_at,
          completed_at = EXCLUDED.completed_at
        RETURNING record
      `,
      values: [
        record.id,
        record.tenantId ?? null,
        record.projectId ?? null,
        record.sessionId ?? null,
        record.state,
        record.executionMode,
        record.provider ?? null,
        record.providerJobId ?? null,
        record.timeoutSeconds ?? null,
        record.exitCode ?? null,
        record.terminalReason ?? null,
        record.artifactCount ?? 0,
        record.actor ?? null,
        json(record.metadata ?? {}),
        json(record),
        timestamp(record.createdAt),
        timestamp(record.updatedAt),
        nullableTimestamp(record.completedAt),
      ],
    });
    return clone(result.rows[0].record);
  }

  async getJob(jobId) {
    return this.#recordOrNull({
      name: 'getJob',
      sql: 'SELECT record FROM gateway_jobs WHERE id = $1',
      values: [jobId],
    });
  }

  async listJobs(options = {}) {
    const conditions = [];
    const values = [];
    if (options.tenantId) {
      values.push(options.tenantId);
      conditions.push(`tenant_id = $${values.length}`);
    }
    if (options.projectId) {
      values.push(options.projectId);
      conditions.push(`project_id = $${values.length}`);
    }
    if (options.sessionId) {
      values.push(options.sessionId);
      conditions.push(`session_id = $${values.length}`);
    }
    if (options.state) {
      values.push(options.state);
      conditions.push(`state = $${values.length}`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    let limitClause = '';
    if (options.limit !== undefined && options.limit !== null) {
      values.push(options.limit);
      limitClause = `LIMIT $${values.length}`;
    }
    let offsetClause = '';
    if (options.offset > 0) {
      values.push(options.offset);
      offsetClause = `OFFSET $${values.length}`;
    }
    const order = options.limit !== undefined ? 'DESC' : 'ASC';
    const result = await this.#single({
      name: 'listJobs',
      sql: `
        SELECT record
        FROM gateway_jobs
        ${where}
        ORDER BY created_at ${order}
        ${limitClause} ${offsetClause}
      `,
      values,
    });
    return result.rows.map((row) => clone(row.record));
  }

  async initializeJobBuckets() {
    return null;
  }

  async appendEvent(jobId, event) {
    const record = clone(event);
    const result = await this.#single({
      name: 'appendEvent',
      sql: `
        INSERT INTO gateway_job_events (
          id, job_id, sequence, type, provider, at, payload, record
        ) VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::jsonb, $8::jsonb)
        ON CONFLICT (id) DO UPDATE SET
          payload = EXCLUDED.payload,
          record = EXCLUDED.record
        RETURNING record
      `,
      values: [
        record.id ?? `${record.sequence}`,
        jobId,
        record.sequence,
        record.type,
        record.provider ?? null,
        timestamp(record.at),
        json(record),
        json(record),
      ],
    });
    return clone(result.rows[0].record);
  }

  async listJobEvents(jobId, { afterSequence = 0 } = {}) {
    const result = await this.#single({
      name: 'listJobEvents',
      sql: `
        SELECT record
        FROM gateway_job_events
        WHERE job_id = $1 AND sequence > $2
        ORDER BY sequence ASC
      `,
      values: [jobId, afterSequence],
    });
    return result.rows.map((row) => clone(row.record));
  }

  async saveArtifact(jobId, artifact) {
    const record = { ...clone(artifact), jobId: artifact.jobId ?? jobId };
    const result = await this.#single({
      name: 'saveArtifact',
      sql: `
        INSERT INTO gateway_artifacts (
          id, job_id, kind, name, storage_uri, download_handle, download_url,
          content_type, size_bytes, sha256, retention_class, metadata, record,
          created_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
          $12::jsonb, $13::jsonb, $14::timestamptz
        )
        ON CONFLICT (id) DO UPDATE SET
          job_id = EXCLUDED.job_id,
          kind = EXCLUDED.kind,
          name = EXCLUDED.name,
          storage_uri = EXCLUDED.storage_uri,
          download_handle = EXCLUDED.download_handle,
          download_url = EXCLUDED.download_url,
          content_type = EXCLUDED.content_type,
          size_bytes = EXCLUDED.size_bytes,
          sha256 = EXCLUDED.sha256,
          retention_class = EXCLUDED.retention_class,
          metadata = EXCLUDED.metadata,
          record = EXCLUDED.record
        RETURNING record
      `,
      values: [
        record.id,
        record.jobId,
        record.kind,
        record.name,
        record.storageUri ?? null,
        record.downloadHandle ?? null,
        record.downloadUrl ?? null,
        record.contentType ?? null,
        record.sizeBytes ?? null,
        record.sha256 ?? null,
        record.retentionClass ?? null,
        json(record.metadata ?? {}),
        json(record),
        timestamp(record.createdAt),
      ],
    });
    return clone(result.rows[0].record);
  }

  async listJobArtifacts(jobId) {
    const result = await this.#single({
      name: 'listJobArtifacts',
      sql: 'SELECT record FROM gateway_artifacts WHERE job_id = $1 ORDER BY created_at ASC',
      values: [jobId],
    });
    return result.rows.map((row) => clone(row.record));
  }

  async getArtifact(artifactId) {
    return this.#recordOrNull({
      name: 'getArtifact',
      sql: 'SELECT record FROM gateway_artifacts WHERE id = $1',
      values: [artifactId],
    });
  }

  async listArtifactManifests({ limit = 1000 } = {}) {
    const result = await this.#single({
      name: 'listArtifactManifests',
      sql: `
        SELECT record
        FROM gateway_artifacts
        ORDER BY created_at ASC
        LIMIT $1
      `,
      values: [limit],
    });
    return result.rows.map((row) => clone(row.record));
  }

  async deleteArtifactManifest(artifactId) {
    const result = await this.#single({
      name: 'deleteArtifactManifest',
      sql: `
        DELETE FROM gateway_artifacts
        WHERE id = $1
        RETURNING record
      `,
      values: [artifactId],
    });
    return result.rows[0] ? clone(result.rows[0].record) : null;
  }

  async recordCancellation(jobId, cancellation) {
    const record = {
      jobId,
      reason: cancellation.reason ?? 'cancelled',
      requestedBy: cancellation.requestedBy ?? null,
      requestedAt: cancellation.requestedAt,
      providerAckAt: cancellation.providerAckAt ?? null,
    };
    const result = await this.#single({
      name: 'recordCancellation',
      sql: `
        INSERT INTO gateway_cancellations (
          job_id, reason, requested_by, requested_at, provider_ack_at, record
        ) VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6::jsonb)
        ON CONFLICT (job_id) DO UPDATE SET
          reason = EXCLUDED.reason,
          requested_by = EXCLUDED.requested_by,
          requested_at = EXCLUDED.requested_at,
          provider_ack_at = EXCLUDED.provider_ack_at,
          record = EXCLUDED.record
        RETURNING record
      `,
      values: [
        jobId,
        record.reason,
        record.requestedBy,
        timestamp(record.requestedAt),
        nullableTimestamp(record.providerAckAt),
        json(record),
      ],
    });
    return clone(result.rows[0].record);
  }

  async getCancellation(jobId) {
    return this.#recordOrNull({
      name: 'getCancellation',
      sql: 'SELECT record FROM gateway_cancellations WHERE job_id = $1',
      values: [jobId],
    });
  }

  async saveIdempotencyKey(key, value) {
    const record = { key, ...clone(value) };
    const result = await this.#single({
      name: 'saveIdempotencyKey',
      sql: `
        INSERT INTO gateway_idempotency_keys (
          key, tenant_id, scope, request_hash, resource_type, resource_id,
          status_code, response_body, created_at, expires_at, record
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8::jsonb,
          $9::timestamptz, $10::timestamptz, $11::jsonb
        )
        ON CONFLICT (key) DO UPDATE SET
          tenant_id = EXCLUDED.tenant_id,
          scope = EXCLUDED.scope,
          request_hash = EXCLUDED.request_hash,
          resource_type = EXCLUDED.resource_type,
          resource_id = EXCLUDED.resource_id,
          status_code = EXCLUDED.status_code,
          response_body = EXCLUDED.response_body,
          expires_at = EXCLUDED.expires_at,
          record = EXCLUDED.record
        RETURNING record
      `,
      values: [
        key,
        record.tenantId ?? null,
        record.scope,
        record.requestHash,
        record.resourceType ?? null,
        record.resourceId ?? null,
        record.statusCode ?? null,
        json(record.responseBody ?? null),
        timestamp(record.createdAt),
        nullableTimestamp(record.expiresAt),
        json(record),
      ],
    });
    return clone(result.rows[0].record);
  }

  async getIdempotencyKey(key) {
    return this.#recordOrNull({
      name: 'getIdempotencyKey',
      sql: 'SELECT record FROM gateway_idempotency_keys WHERE key = $1',
      values: [key],
    });
  }

  async saveServiceToken(token) {
    const tokenHash = token.tokenHash ?? hashGatewayServiceToken(token.token);
    const now = new Date().toISOString();
    const result = await this.#single({
      name: 'saveServiceToken',
      sql: `
        INSERT INTO gateway_service_tokens (
          token_ref, token_hash, actor, scopes, tenant_ids, project_ids,
          expires_at, revoked_at, metadata, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4::text[], $5::text[], $6::text[],
          $7::timestamptz, $8::timestamptz, $9::jsonb,
          $10::timestamptz, $11::timestamptz
        )
        ON CONFLICT (token_ref) DO UPDATE SET
          token_hash = EXCLUDED.token_hash,
          actor = EXCLUDED.actor,
          scopes = EXCLUDED.scopes,
          tenant_ids = EXCLUDED.tenant_ids,
          project_ids = EXCLUDED.project_ids,
          expires_at = EXCLUDED.expires_at,
          revoked_at = EXCLUDED.revoked_at,
          metadata = EXCLUDED.metadata,
          updated_at = EXCLUDED.updated_at
        RETURNING *
      `,
      values: [
        token.tokenRef ?? 'service-token',
        tokenHash,
        token.actor ?? token.tokenRef ?? 'service-token',
        token.scopes ?? [],
        token.tenantIds ?? [],
        token.projectIds ?? [],
        nullableTimestamp(token.expiresAt),
        nullableTimestamp(token.revokedAt),
        json(token.metadata ?? {}),
        timestamp(token.createdAt ?? now),
        timestamp(token.updatedAt ?? now),
      ],
    });
    return serviceTokenFromRow(result.rows[0]);
  }

  async getServiceTokenByHash(tokenHash) {
    const result = await this.#single({
      name: 'getServiceTokenByHash',
      sql: `
        SELECT *
        FROM gateway_service_tokens
        WHERE token_hash = $1 AND revoked_at IS NULL
        LIMIT 1
      `,
      values: [tokenHash],
    });
    return result.rows[0] ? serviceTokenFromRow(result.rows[0]) : null;
  }

  async getServiceToken(tokenRef) {
    const result = await this.#single({
      name: 'getServiceToken',
      sql: `
        SELECT *
        FROM gateway_service_tokens
        WHERE token_ref = $1
        LIMIT 1
      `,
      values: [tokenRef],
    });
    return result.rows[0] ? serviceTokenFromRow(result.rows[0]) : null;
  }

  async listServiceTokens({ includeRevoked = true, limit = 100 } = {}) {
    const values = [limit];
    const where = includeRevoked ? '' : 'WHERE revoked_at IS NULL';
    const result = await this.#single({
      name: 'listServiceTokens',
      sql: `
        SELECT *
        FROM gateway_service_tokens
        ${where}
        ORDER BY created_at DESC
        LIMIT $1
      `,
      values,
    });
    return result.rows.map(serviceTokenFromRow);
  }

  async revokeServiceToken(tokenRef, { revokedAt = new Date().toISOString(), metadata = {} } = {}) {
    const result = await this.#single({
      name: 'revokeServiceToken',
      sql: `
        UPDATE gateway_service_tokens
        SET
          revoked_at = $2::timestamptz,
          metadata = metadata || $3::jsonb,
          updated_at = $4::timestamptz
        WHERE token_ref = $1
        RETURNING *
      `,
      values: [
        tokenRef,
        timestamp(revokedAt),
        json(metadata),
        new Date().toISOString(),
      ],
    });
    return result.rows[0] ? serviceTokenFromRow(result.rows[0]) : null;
  }

  async recordAudit(record = {}) {
    const audit = {
      id: record.id ?? `aud_${randomUUID()}`,
      action: record.action,
      scope: record.scope ?? null,
      tokenRef: record.tokenRef ?? null,
      actor: record.actor ?? null,
      tenantId: record.tenantId ?? null,
      projectId: record.projectId ?? null,
      resourceType: record.resourceType ?? null,
      resourceId: record.resourceId ?? null,
      outcome: record.outcome,
      reason: record.reason ?? null,
      metadata: record.metadata ?? {},
      at: record.at ?? new Date().toISOString(),
    };
    const result = await this.#single({
      name: 'recordAudit',
      sql: `
        INSERT INTO gateway_audit_records (
          id, action, scope, token_ref, actor, tenant_id, project_id,
          resource_type, resource_id, outcome, reason, metadata, at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
          $12::jsonb, $13::timestamptz
        )
        RETURNING *
      `,
      values: [
        audit.id,
        audit.action,
        audit.scope,
        audit.tokenRef,
        audit.actor,
        audit.tenantId,
        audit.projectId,
        audit.resourceType,
        audit.resourceId,
        audit.outcome,
        audit.reason,
        json(audit.metadata),
        timestamp(audit.at),
      ],
    });
    return auditFromRow(result.rows[0]);
  }

  async listAuditRecords({
    tokenRef,
    actor,
    action,
    outcome,
    tenantId,
    projectId,
    limit = 50,
    offset = 0,
  } = {}) {
    const conditions = [];
    const values = [];
    if (tokenRef) {
      values.push(tokenRef);
      conditions.push(`token_ref = $${values.length}`);
    }
    if (actor) {
      values.push(actor);
      conditions.push(`actor = $${values.length}`);
    }
    if (action) {
      values.push(action);
      conditions.push(`action = $${values.length}`);
    }
    if (outcome) {
      values.push(outcome);
      conditions.push(`outcome = $${values.length}`);
    }
    if (tenantId) {
      values.push(tenantId);
      conditions.push(`tenant_id = $${values.length}`);
    }
    if (projectId) {
      values.push(projectId);
      conditions.push(`project_id = $${values.length}`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    values.push(limit);
    const limitIdx = values.length;
    let offsetClause = '';
    if (offset > 0) {
      values.push(offset);
      offsetClause = `OFFSET $${values.length}`;
    }
    const result = await this.#single({
      name: 'listAuditRecords',
      sql: `
        SELECT *
        FROM gateway_audit_records
        ${where}
        ORDER BY at DESC
        LIMIT $${limitIdx} ${offsetClause}
      `,
      values,
    });
    return result.rows.map(auditFromRow);
  }

  async listIdempotencyKeys({ tenantId, scope, limit = 50, offset = 0 } = {}) {
    const conditions = [];
    const values = [];
    if (tenantId) {
      values.push(tenantId);
      conditions.push(`tenant_id = $${values.length}`);
    }
    if (scope) {
      values.push(scope);
      conditions.push(`scope = $${values.length}`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    values.push(limit);
    const limitIdx = values.length;
    values.push(offset);
    const offsetIdx = values.length;
    const result = await this.#single({
      name: 'listIdempotencyKeys',
      sql: `
        SELECT record
        FROM gateway_idempotency_keys
        ${where}
        ORDER BY created_at DESC
        LIMIT $${limitIdx} OFFSET $${offsetIdx}
      `,
      values,
    });
    return result.rows.map((row) => clone(row.record));
  }

  async getOverview() {
    const jobsResult = await this.#single({
      name: 'overviewJobs',
      sql: `
        SELECT state, count(*)::int AS count
        FROM gateway_jobs
        GROUP BY state
      `,
    });
    const sessionsResult = await this.#single({
      name: 'overviewSessions',
      sql: `
        SELECT state, count(*)::int AS count
        FROM gateway_sessions
        GROUP BY state
      `,
    });
    const auditCountResult = await this.#single({
      name: 'overviewAuditCount',
      sql: `SELECT count(*)::int AS count FROM gateway_audit_records`,
    });
    const idempotencyCountResult = await this.#single({
      name: 'overviewIdempotencyCount',
      sql: `SELECT count(*)::int AS count FROM gateway_idempotency_keys`,
    });

    const jobsByState = Object.fromEntries(jobsResult.rows.map((r) => [r.state, r.count]));
    const totalJobs = Object.values(jobsByState).reduce((acc, v) => acc + v, 0);
    const runningJobs = (jobsByState.running ?? 0) + (jobsByState.preparing ?? 0);

    const sessionsByState = Object.fromEntries(sessionsResult.rows.map((r) => [r.state, r.count]));
    const totalSessions = Object.values(sessionsByState).reduce((acc, v) => acc + v, 0);
    const activeSessions = (sessionsByState.ready ?? 0) + (sessionsByState.busy ?? 0) + (sessionsByState.provisioning ?? 0);

    return {
      jobs: {
        total: totalJobs,
        running: runningJobs,
        byState: jobsByState,
      },
      sessions: {
        total: totalSessions,
        active: activeSessions,
        byState: sessionsByState,
      },
      auditRecordsCount: auditCountResult.rows[0]?.count ?? 0,
      idempotencyKeysCount: idempotencyCountResult.rows[0]?.count ?? 0,
      pool: this.stats(),
    };
  }

  async healthCheck() {
    if (this.runner.healthCheck) {
      return this.runner.healthCheck();
    }
    await this.#single({
      name: 'healthCheck',
      sql: 'SELECT 1 AS ok',
    });
    return { status: 'ready' };
  }

  stats() {
    return this.runner.stats?.() ?? null;
  }

  async close() {
    await this.runner.close?.();
  }

  async #recordOrNull(statement) {
    const result = await this.#single(statement);
    return result.rows[0] ? clone(result.rows[0].record) : null;
  }

  async #single(statement) {
    return (await this.#execute([statement]))[0];
  }

  async #execute(statements) {
    const response = await this.runner.execute({
      connectionString: this.connectionString,
      statements,
    });
    return response.results;
  }
}

export class PgPoolPostgresRunner {
  constructor({
    connectionString = process.env.POSTGRES_URL,
    pool = null,
    poolOptions = {},
    queryTimeoutMs = parseInteger(process.env.GATEWAY_POSTGRES_QUERY_TIMEOUT_MS, 30000),
  } = {}) {
    if (!connectionString && !pool) {
      throw new TypeError('PgPoolPostgresRunner requires connectionString, POSTGRES_URL, or pool');
    }
    this.pool = pool ?? new Pool({
      connectionString,
      max: parseInteger(process.env.GATEWAY_POSTGRES_POOL_MAX, 10),
      idleTimeoutMillis: parseInteger(process.env.GATEWAY_POSTGRES_IDLE_TIMEOUT_MS, 30000),
      connectionTimeoutMillis: parseInteger(process.env.GATEWAY_POSTGRES_CONNECT_TIMEOUT_MS, 5000),
      ...poolOptions,
    });
    this.ownsPool = !pool;
    this.queryTimeoutMs = queryTimeoutMs;
  }

  async execute(payload) {
    const client = await this.pool.connect();
    let activeStatement = null;
    try {
      const results = [];
      for (const statement of payload.statements) {
        activeStatement = statement;
        const query = {
          text: statement.sql,
          values: statement.values ?? [],
        };
        if (this.queryTimeoutMs > 0) {
          query.query_timeout = this.queryTimeoutMs;
        }
        const result = await client.query(query);
        results.push({
          rows: result.rows,
          rowCount: result.rowCount,
        });
      }
      return { results };
    } catch (error) {
      const name = activeStatement?.name ?? 'statement';
      throw new Error(`PostgresGatewayStore query failed in ${name}: ${error.message}`);
    } finally {
      client.release();
    }
  }

  async healthCheck() {
    const startedAt = Date.now();
    await this.pool.query('SELECT 1 AS ok');
    return {
      status: 'ready',
      latencyMs: Date.now() - startedAt,
      pool: this.stats(),
    };
  }

  stats() {
    return {
      totalCount: this.pool.totalCount,
      idleCount: this.pool.idleCount,
      waitingCount: this.pool.waitingCount,
    };
  }

  async close() {
    if (this.ownsPool) {
      await this.pool.end();
    }
  }
}

function serviceTokenFromRow(row) {
  return {
    tokenHash: row.token_hash,
    tokenRef: row.token_ref,
    actor: row.actor,
    scopes: row.scopes ?? [],
    tenantIds: row.tenant_ids ?? [],
    projectIds: row.project_ids ?? [],
    expiresAt: isoOrNull(row.expires_at),
    revokedAt: isoOrNull(row.revoked_at),
    metadata: row.metadata ?? {},
    createdAt: isoOrNull(row.created_at),
    updatedAt: isoOrNull(row.updated_at),
  };
}

function auditFromRow(row) {
  return {
    id: row.id,
    action: row.action,
    scope: row.scope,
    tokenRef: row.token_ref,
    actor: row.actor,
    tenantId: row.tenant_id,
    projectId: row.project_id,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    outcome: row.outcome,
    reason: row.reason,
    metadata: row.metadata ?? {},
    at: isoOrNull(row.at),
  };
}

function json(value) {
  return JSON.stringify(value ?? null);
}

function timestamp(value) {
  return value ?? new Date().toISOString();
}

function nullableTimestamp(value) {
  return value ?? null;
}

function isoOrNull(value) {
  if (!value) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : value;
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function clone(value) {
  if (value === undefined || value === null) {
    return value ?? null;
  }
  return structuredClone(value);
}
