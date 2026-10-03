# Local Gateway Smoke Harness

This harness runs the current HTTP Agent Execution Gateway locally with deterministic ports and local persistence dependencies. It does not require JuiceFS.

## Services

`docker-compose.gateway-smoke.yml` starts:

- `gateway` on `127.0.0.1:18080`, backed by `LocalSandboxProvider`, `PostgresGatewayStore`, and `S3ArtifactStore`
- `postgres` on `127.0.0.1:15432`, storing gateway sessions, jobs, events, artifacts, cancellations, service-token metadata, idempotency keys, and audit records
- `minio` on `127.0.0.1:19000` and console on `127.0.0.1:19001`, with bucket `partners-artifacts`

The gateway image writes transient workspaces to `/var/lib/partners/workspaces` and copied-out artifacts to `/var/lib/partners/artifacts`. Both paths are Docker volumes so operators can inspect failed smoke runs without relying on host-mounted JuiceFS.

## Run

```bash
docker compose -f docker-compose.gateway-smoke.yml up -d --build
SMOKE_CHECK_DEPENDENCIES=1 \
SMOKE_EXPECT_ARTIFACT_BACKEND=s3 \
SMOKE_RESTART_COMMAND="docker compose -f docker-compose.gateway-smoke.yml restart gateway" \
  npm run gateway:smoke
docker compose -f docker-compose.gateway-smoke.yml down -v
```

The smoke script prints one JSON document. `ok: true` means it verified:

- gateway health
- Postgres TCP readiness and MinIO readiness when `SMOKE_CHECK_DEPENDENCIES=1`
- missing-token denial
- out-of-scope tenant denial
- session create/read/delete
- job submission and successful completion
- SSE event replay with `Last-Event-ID`
- artifact listing and download without exposing local paths
- cancellation of a running job
- gateway restart durability when `SMOKE_RESTART_COMMAND` is set
- S3 storage URI, S3 download handle, checksum, content type, and download content when `SMOKE_EXPECT_ARTIFACT_BACKEND=s3`

## Configuration

Gateway service environment:

- `GATEWAY_HOST`, default `0.0.0.0`
- `GATEWAY_PORT`, default `8080`
- `GATEWAY_STORE`, set to `postgres` to use `PostgresGatewayStore`; default `memory`
- `GATEWAY_WORK_ROOT`, default `/tmp/partners-workspaces`
- `GATEWAY_ARTIFACT_ROOT`, default `/tmp/partners-artifacts`
- `GATEWAY_ARTIFACT_STORE`, set to `s3` to use `S3ArtifactStore`; default `local`
- `GATEWAY_SERVICE_TOKEN`, unset disables auth
- `GATEWAY_SERVICE_SCOPES`, comma-separated, default `*` when a token is set
- `GATEWAY_TENANT_IDS`, comma-separated tenant allow-list
- `GATEWAY_PROJECT_IDS`, comma-separated project allow-list
- `GATEWAY_SERVICE_TOKEN_EXPIRES_AT`, optional ISO timestamp
- `POSTGRES_URL`, required when `GATEWAY_STORE=postgres`
- `S3_ENDPOINT` and `S3_BUCKET`, currently logged for operator visibility and reserved for the S3 backend
- `S3_REGION`, `S3_PREFIX`, `S3_ACCESS_KEY_ID`, and `S3_SECRET_ACCESS_KEY`, required when `GATEWAY_ARTIFACT_STORE=s3`

Smoke script environment:

- `GATEWAY_BASE_URL`, default `http://127.0.0.1:18080`
- `GATEWAY_SERVICE_TOKEN`, default `local-dev-token`
- `SMOKE_TENANT_ID`, default `local`
- `SMOKE_PROJECT_ID`, default `partners`
- `SMOKE_CHECK_DEPENDENCIES`, set to `1` to require Postgres and MinIO checks
- `SMOKE_POSTGRES_HOST`, default `127.0.0.1`
- `SMOKE_POSTGRES_PORT`, default `15432`
- `SMOKE_MINIO_HEALTH_URL`, default `http://127.0.0.1:19000/minio/health/ready`
- `SMOKE_TIMEOUT_MS`, default `30000`
- `SMOKE_RESTART_COMMAND`, optional shell command to restart the gateway and verify durable jobs, events, cancellation state, artifact manifests, and artifact downloads
- `SMOKE_EXPECT_ARTIFACT_BACKEND`, set to `s3` to assert S3 manifest fields

## Troubleshooting

Check service status:

```bash
docker compose -f docker-compose.gateway-smoke.yml ps
docker compose -f docker-compose.gateway-smoke.yml logs gateway
```

If `missing token is denied` fails, confirm the gateway was started with `GATEWAY_SERVICE_TOKEN=local-dev-token` and the smoke script uses the same token.

If artifact download fails, inspect the gateway artifact volume:

```bash
docker compose -f docker-compose.gateway-smoke.yml exec gateway find /var/lib/partners/artifacts -maxdepth 4 -type f
```

If the smoke script times out on MinIO, check that bucket bootstrap completed:

```bash
docker compose -f docker-compose.gateway-smoke.yml logs minio-bootstrap
```

## Gate For Durable Backends

This harness is the local gate for production packaging. Postgres owns gateway lifecycle state and audit metadata, MinIO stores copied-out artifact bytes through `S3ArtifactStore`, and the smoke script can restart the gateway to verify jobs, events, cancellation state, artifact manifests, and artifact downloads survive process restart.
