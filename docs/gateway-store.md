# GatewayStore Boundary

Status: in-memory store and async Postgres pool store implemented.

Reviewed on: 2026-07-05

## Goal

Keep gateway orchestration independent from its persistence backend. The
gateway core should create and update sessions, jobs, events, artifacts,
cancellation markers, and idempotency records through a store boundary instead
of owning mutable maps directly.

`InMemoryGatewayStore` is the default implementation. It is process-local and
intended for unit tests and local development.

`PostgresGatewayStore` is the durable implementation. It now uses a long-lived
`pg.Pool` through `PgPoolPostgresRunner` instead of spawning a short-lived worker
process for each store call. Gateway orchestration treats store calls as
async-first, while `InMemoryGatewayStore` remains a simple synchronous-compatible
test and local implementation.

## Store Surface

Current operations are awaited by gateway orchestration:

| Area | Operations |
| --- | --- |
| Event sequence | `nextEventSequence()` |
| Sessions | `saveSession`, `getSession` |
| Jobs | `saveJob`, `getJob`, `listJobs`, `initializeJobBuckets` |
| Events | `appendEvent`, `listJobEvents` |
| Artifacts | `saveArtifact`, `listJobArtifacts`, `getArtifact` |
| Cancellation | `recordCancellation`, `getCancellation` |
| Idempotency | `saveIdempotencyKey`, `getIdempotencyKey` |
| Operations | `healthCheck`, `stats`, `close` |

The in-memory implementation clones values at read/write boundaries so callers
do not accidentally mutate stored records outside store methods.

## Async Gateway Core Mapping

`InMemoryAgentExecutionGateway` now accepts `store` in its constructor and
defaults to `new InMemoryGatewayStore()`. It writes:

- accepted job records before provider execution starts
- queued, provider, cancellation, artifact, and final events with monotonic
  gateway sequence numbers
- job status changes after lifecycle and final events
- artifact manifests from provider events and final provider results
- cancellation markers before forwarding cancellation to the provider

Provider event callbacks may still be called without `await` by existing
providers. The gateway serializes those callbacks through an internal promise
queue before final job persistence, so event sequence allocation, artifact
indexing, and final status writes remain ordered with async stores.

HTTP routes use gateway methods only. Artifact downloads call
`gateway.getArtifact(artifactId)` instead of reaching into internal maps.

## Postgres Mapping

Durable tables:

| Table | Key fields | Notes |
| --- | --- | --- |
| `gateway_sessions` | `id`, `tenant_id`, `project_id`, `state`, `provider`, `provider_session_id`, `metadata`, `created_at`, `updated_at` | One row per workspace session. |
| `gateway_jobs` | `id`, `tenant_id`, `project_id`, `session_id`, `state`, `execution_mode`, `provider`, `provider_job_id`, `timeout_seconds`, `exit_code`, `terminal_reason`, `artifact_count`, `metadata`, `created_at`, `updated_at`, `completed_at` | Authoritative job lifecycle row. |
| `gateway_job_events` | `id`, `job_id`, `sequence`, `type`, `payload`, `provider`, `at` | Unique `(job_id, sequence)`; sequence may come from a global sequence or per-job counter. |
| `gateway_artifacts` | `id`, `job_id`, `kind`, `name`, `storage_uri`, `download_handle`, `download_url`, `content_type`, `size_bytes`, `sha256`, `retention_class`, `metadata`, `created_at` | Never store sandbox-local paths as public handles. |
| `gateway_cancellations` | `job_id`, `reason`, `requested_by`, `requested_at`, `provider_ack_at` | One latest marker per job is enough for first durability pass. |
| `gateway_idempotency_keys` | `key`, `tenant_id`, `scope`, `request_hash`, `resource_type`, `resource_id`, `status_code`, `response_body`, `created_at`, `expires_at` | Unique key per tenant/scope. |
| `gateway_service_tokens` | `token_ref`, `token_hash`, `actor`, `scopes`, `tenant_ids`, `project_ids`, `expires_at`, `revoked_at`, `metadata`, `created_at`, `updated_at` | Stores token hashes only. |
| `gateway_audit_records` | `id`, `action`, `scope`, `token_ref`, `actor`, `tenant_id`, `project_id`, `resource_type`, `resource_id`, `outcome`, `reason`, `metadata`, `at` | Records accepted and denied authorization decisions. |

Indexes:

- `gateway_jobs(tenant_id, project_id, created_at desc)`
- `gateway_jobs(session_id, created_at desc)`
- `gateway_job_events(job_id, sequence)`
- `gateway_artifacts(job_id, created_at)`
- `gateway_idempotency_keys(tenant_id, scope, key)`
- expiry index for `gateway_idempotency_keys(expires_at)`
- `gateway_audit_records(tenant_id, project_id, at desc)`
- `gateway_audit_records(token_ref, at desc)`

## Runtime Selection

The gateway service uses the in-memory store by default. Set:

```bash
GATEWAY_STORE=postgres
POSTGRES_URL=postgres://partners:partners@postgres:5432/partners
```

on `scripts/gateway-service.mjs` to run migrations, bootstrap any
`GATEWAY_SERVICE_TOKEN` into `gateway_service_tokens`, and use Postgres for
sessions, jobs, events, artifacts, cancellations, idempotency keys, service
tokens, and audit records.

Pool tuning:

```bash
GATEWAY_POSTGRES_POOL_MAX=10
GATEWAY_POSTGRES_CONNECT_TIMEOUT_MS=5000
GATEWAY_POSTGRES_IDLE_TIMEOUT_MS=30000
GATEWAY_POSTGRES_QUERY_TIMEOUT_MS=30000
```

`/ready` calls `store.healthCheck()` when available and includes pool stats such
as `totalCount`, `idleCount`, and `waitingCount`. Shutdown calls `store.close()`
so owned Postgres pools drain cleanly after the HTTP listener stops.

## Migration and Rollback

The async boundary is source-compatible for in-memory stores because `await`
accepts plain return values. A rollback can switch `GATEWAY_STORE=memory` without
schema changes. Postgres data remains compatible because table schemas and
record JSON shapes are unchanged; only the runtime runner changed from worker
process execution to pooled client execution.

## Idempotency Rules

For create routes, callers may send `Idempotency-Key`. The accepted format is
8-200 characters from `A-Z`, `a-z`, `0-9`, `.`, `_`, `~`, `:`, and `-`.
Gateway storage derives an internal key from the external idempotency key,
route scope, tenant id, and project id, so the same caller key can be reused
independently across tenants or projects.

For `POST /v1/jobs`, derive `request_hash` with `sha256:stable-json-v1`:

- sort object keys recursively; preserve array order
- include route scope `jobs:create`, tenant id, and project id
- include the JSON request body after redacting secret-shaped fields such as
  bearer tokens, API keys, passwords, private keys, and inline secrets
- exclude gateway-auth metadata added by the HTTP service after authorization

On first successful acceptance, store the idempotency key, request hash,
resource id, status code, response body, creation time, and expiry. On retry:

- same key and same request hash: return the stored response
- same key and different request hash: return `409 Conflict`
- expired key: treat as absent after cleanup

Do not store raw credentials or inline secrets in `request_hash` inputs or
response bodies. Hash redacted request shapes only. The default expiry is 24
hours unless a tenant policy overrides it.

## Retention

Suggested first durable policy:

- job/session rows: keep for audit according to tenant policy
- events: keep full logs for a short operational window, then compact or archive
- artifacts: governed by ArtifactStore retention and legal hold metadata
- idempotency keys: keep 24 hours by default, with tenant override
- cancellation markers: keep with the job row for audit

Durable cleanup must delete bytes through ArtifactStore before removing artifact
manifest rows unless the backend owns independent lifecycle policies.
