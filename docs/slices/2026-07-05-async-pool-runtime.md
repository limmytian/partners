# Async Pool Runtime Slice

Date: 2026-07-05

Requirement: Promote Postgres/S3 adapters to production async pool runtime.

## Scope

This slice promotes the gateway persistence and object-storage paths away from
short-lived worker processes. JuiceFS-backed storage remains out of scope.

## Decisions

- Gateway store calls are async-first. `InMemoryGatewayStore` remains usable
  because awaited synchronous values resolve immediately.
- `PostgresGatewayStore` uses `PgPoolPostgresRunner`, backed by a long-lived
  `pg.Pool`, for durable gateway state, service tokens, and audit records.
- Provider event callbacks are serialized inside `InMemoryAgentExecutionGateway`
  so providers can keep calling `onEvent(event)` without awaiting while async
  stores still preserve sequence and final-state ordering.
- `S3ArtifactStore` uses async `fetch` for S3-compatible PUT, GET, and DELETE
  operations. Presigned URL generation remains local and synchronous.
- The gateway service now awaits Postgres migrations and service-token bootstrap
  before listening, reports store health in `/ready`, and closes owned resources
  during shutdown.

## Operations

Postgres pool tuning:

```bash
GATEWAY_POSTGRES_POOL_MAX=10
GATEWAY_POSTGRES_CONNECT_TIMEOUT_MS=5000
GATEWAY_POSTGRES_IDLE_TIMEOUT_MS=30000
GATEWAY_POSTGRES_QUERY_TIMEOUT_MS=30000
```

Runtime selection remains:

```bash
GATEWAY_STORE=postgres
GATEWAY_ARTIFACT_STORE=s3
```

Rollback can switch either backend to `memory` or `local` without schema
rollback. Postgres table shape and artifact manifest shape are unchanged.

## Verification

- `npm test`
- Unit coverage for async provider event serialization.
- Unit coverage for pooled Postgres query timeout propagation, health stats,
  release-on-error, and statement-name error wrapping.
- Existing HTTP coverage exercises async job reads, SSE replay, cancellation,
  artifact manifests, and gateway-mediated downloads.
