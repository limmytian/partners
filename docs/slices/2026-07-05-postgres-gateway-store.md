# Durable Postgres GatewayStore Handoff

## Scope

Added a durable Postgres store for the Agent Execution Gateway without changing the existing synchronous `GatewayStore` boundary.

## Outputs

- `src/gateway/postgres-gateway-store.js` defines the schema migration SQL and `PostgresGatewayStore`.
- Superseded: this slice originally used `src/gateway/postgres-gateway-store-worker.mjs` to preserve a synchronous boundary. The async pool runtime slice removed that worker and replaced it with `PgPoolPostgresRunner`.
- `scripts/gateway-service.mjs` supports `GATEWAY_STORE=postgres`, runs migrations, bootstraps `GATEWAY_SERVICE_TOKEN` into hashed service-token storage, and wires the authorizer to the token store.
- `GatewayServiceAuthorizer` can load tokens from a token store and writes accepted/denied authorization audit records.
- `LocalArtifactStore` can recover artifact bytes from persisted manifests after a gateway restart.
- `scripts/gateway-smoke.mjs` supports `SMOKE_RESTART_COMMAND` to restart the gateway and verify durable jobs, events, cancellations, artifact manifests, and downloads.
- `docker-compose.gateway-smoke.yml` now runs the gateway against Postgres by default.

## Tables

The migration creates tables for sessions, jobs, job events, artifacts, cancellations, idempotency keys, service tokens, and audit records. Service tokens store hashes only; raw bearer values are never written to records or audit rows.

## Verification

Run:

```bash
npm test
docker compose -f docker-compose.gateway-smoke.yml up -d --build
POSTGRES_URL=postgres://partners:partners@127.0.0.1:15432/partners npm test
SMOKE_CHECK_DEPENDENCIES=1 \
SMOKE_RESTART_COMMAND="docker compose -f docker-compose.gateway-smoke.yml restart gateway" \
  npm run gateway:smoke
docker compose -f docker-compose.gateway-smoke.yml down -v
```

## Limits

This handoff is historical. Production throughput work was completed in
`docs/slices/2026-07-05-async-pool-runtime.md`, which moved the gateway store
boundary to async calls backed by a long-lived Postgres pool. Artifact bytes are
handled by the S3 ArtifactStore slice while keeping the Postgres manifest
tables.
