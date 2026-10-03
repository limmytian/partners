# Local Gateway Smoke Harness Handoff

Status: historical handoff. The durable Postgres/S3 compose and restart path
described below is now the implemented local production-packaging gate.

## Scope

Added a local Docker smoke harness for the HTTP Agent Execution Gateway without depending on JuiceFS.

## Outputs

- `Dockerfile.gateway` builds a dependency-free Node gateway image from this repository.
- `docker-compose.gateway-smoke.yml` runs gateway, Postgres, MinIO, and MinIO bucket bootstrap with deterministic host ports.
- `scripts/gateway-service.mjs` starts the HTTP gateway with `LocalSandboxProvider`, `PostgresGatewayStore` when `GATEWAY_STORE=postgres`, `S3ArtifactStore` when `GATEWAY_ARTIFACT_STORE=s3`, optional bearer-token auth, and graceful shutdown.
- `scripts/gateway-smoke.mjs` performs machine-readable end-to-end checks for health, auth denial, session lifecycle, job success, SSE replay, artifact download, and cancellation.
- `docs/local-gateway-smoke.md` documents the current run commands,
  configuration, durable backend behavior, and troubleshooting.

## Current Limits

MinIO is used by the S3 artifact backend in the current compose smoke harness. Restart durability is covered for Postgres-backed lifecycle state and gateway-mediated S3 artifact downloads.

## Verification

Run:

```bash
npm test
node --check scripts/gateway-service.mjs
node --check scripts/gateway-smoke.mjs
docker compose -f docker-compose.gateway-smoke.yml up -d --build
SMOKE_CHECK_DEPENDENCIES=1 \
SMOKE_EXPECT_ARTIFACT_BACKEND=s3 \
SMOKE_RESTART_COMMAND="docker compose -f docker-compose.gateway-smoke.yml restart gateway" \
  npm run gateway:smoke
docker compose -f docker-compose.gateway-smoke.yml down -v
```
