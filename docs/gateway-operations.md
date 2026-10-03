# Gateway Operations Runbook

Status: production packaging baseline.

## Runtime

Run the gateway as a standalone Node process:

```bash
npm run gateway:service
```

or as the Docker image built by `Dockerfile.gateway`. The container runs as the
non-root `node` user and listens on `GATEWAY_PORT`.

Use `config/gateway.env.example` as the environment schema. Secrets must come
from the deployment secret manager, not from committed files.

## Health, Readiness, Metrics

- `GET /health` returns process liveness.
- `GET /ready` returns `200` only after the server has finished startup and
  flips back to `503` during graceful shutdown.
- `GET /metrics` exposes Prometheus text metrics for uptime, HTTP requests, job
  lifecycle, provider runtime duration, Postgres pool gauges, and artifact
  operation failures. See [gateway-observability.md](gateway-observability.md)
  for the metric contract and
  [gateway-observability-alerts.md](gateway-observability-alerts.md) for alert
  and dashboard guidance.

The service emits JSON logs for startup, shutdown, and each HTTP request. Auth
errors are redacted; raw bearer tokens are never logged.

## Smoke Test

```bash
docker compose -f docker-compose.gateway-smoke.yml up -d --build
SMOKE_CHECK_DEPENDENCIES=1 \
SMOKE_EXPECT_ARTIFACT_BACKEND=s3 \
SMOKE_RESTART_COMMAND="docker compose -f docker-compose.gateway-smoke.yml restart gateway" \
  npm run gateway:smoke
docker compose -f docker-compose.gateway-smoke.yml down -v
```

The smoke test validates health, readiness dependencies, auth denial, job
execution, SSE replay, S3 artifact download, cancellation, and restart
durability.

It also submits a provider-neutral custom `sandbox` request using a synthetic
immutable digest and server-side `imagePullSecretRef`. The compose stack uses
the local provider, so this check validates HTTP acceptance, persistence, and
secret-shape rejection; Kubernetes image pull, bootstrap execution, and PVC
recovery require the staging checklist in the runtime runbook.

## Release

Use [gateway-release.md](gateway-release.md) for the release flow:

```bash
npm run gateway:ci-smoke
IMAGE_REPOSITORY=ghcr.io/limmytian/partners-gateway IMAGE_TAG=<tag> \
  bash scripts/gateway-release.sh build
bash scripts/gateway-release.sh push
K8S_CONTEXT=<context> \
GATEWAY_IMAGE_DIGEST=sha256:<gateway-digest> \
SANDBOX_IMAGE_DIGEST=sha256:<sandbox-digest> \
  bash scripts/gateway-release.sh deploy
```

Rollback:

```bash
K8S_CONTEXT=<context> bash scripts/gateway-release.sh rollback
```

## Retention Cleanup

Dry-run artifact retention cleanup:

```bash
POSTGRES_URL=postgres://partners:partners@postgres:5432/partners \
RETENTION_DRY_RUN=1 \
  npm run gateway:cleanup
```

Destructive cleanup deletes bytes first, then manifest rows:

```bash
POSTGRES_URL=postgres://partners:partners@postgres:5432/partners \
GATEWAY_ARTIFACT_STORE=s3 \
S3_ENDPOINT=http://minio:9000 \
S3_BUCKET=partners-artifacts \
S3_ACCESS_KEY_ID=partners \
S3_SECRET_ACCESS_KEY=partners-secret \
RETENTION_DRY_RUN=0 \
  npm run gateway:cleanup
```

Generate and validate S3 lifecycle rules:

```bash
npm run --silent gateway:cleanup -- s3-policy > lifecycle.json
npm run gateway:cleanup -- validate-s3-policy --file lifecycle.json
```

For local development without `POSTGRES_URL`, the same command falls back to
mtime cleanup under `GATEWAY_ARTIFACT_ROOT`. See
[artifact-retention.md](artifact-retention.md).

## Service Token Operations

Create a scoped service token:

```bash
POSTGRES_URL=postgres://partners:partners@postgres:5432/partners \
  npm run gateway:token -- create \
  --ref tok_task_weaver_prod_202607 \
  --actor task-weaver \
  --scope jobs:create,jobs:read,artifacts:read \
  --tenant tenant_1 \
  --project project_1 \
  --expires-at 2026-10-01T00:00:00.000Z
```

The command prints `tokenValue` once. Put that value in the secret manager and
redeploy clients. The database stores only the hash.

Inspect and rotate:

```bash
npm run gateway:token -- list
npm run gateway:token -- audit --ref tok_task_weaver_prod_202607
npm run gateway:token -- rotate \
  --ref tok_task_weaver_prod_202607 \
  --new-ref tok_task_weaver_prod_202610 \
  --expires-at 2027-01-01T00:00:00.000Z
npm run gateway:token -- revoke \
  --ref tok_task_weaver_prod_202607 \
  --reason "clients moved to tok_task_weaver_prod_202610"
```

Use `--json` for automation. Do not paste raw token values into runbooks,
tickets, or shell history beyond the one-time operator handoff.

## Failure Drills

- Postgres unavailable at startup: gateway should fail to start when
  `GATEWAY_STORE=postgres`; restore DB connectivity and restart.
- MinIO/S3 unavailable during job finalization: job should fail rather than
  returning a manifest with missing bytes; inspect gateway logs and retry after
  storage recovery.
- Gateway restart during idle state: `/ready` should return after restart and
  persisted jobs/events/artifact manifests should remain readable.
- Token rotation: create or rotate with `npm run gateway:token`, deploy clients
  with the new one-time value, then revoke the old token and inspect audit rows.
- Rollback: deploy the previous image while keeping Postgres data and S3 bucket
  intact; run the smoke test before shifting traffic back.

## Triage Checklist

- Check `/ready` and `/metrics`.
- Check structured gateway logs for 5xx routes and storage errors.
- Confirm Postgres migrations exist by checking `gateway_jobs` and
  `gateway_audit_records`.
- Confirm S3 bucket access with the configured endpoint, bucket, access key,
  and region.
- Run the smoke test after any config, token, database, or storage change.
