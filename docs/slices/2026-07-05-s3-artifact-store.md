# S3 ArtifactStore Handoff

## Scope

Added an S3-compatible artifact backend and wired the local Docker smoke harness to verify gateway-mediated downloads through MinIO.

## Outputs

- `src/artifacts/s3-artifact-store.js` implements put/read/delete, S3 object key layout, SHA-256 checksums, content type preservation, retention metadata, S3 manifest metadata, and presigned GET URL generation.
- Superseded: this slice originally used `src/artifacts/s3-artifact-store-worker.mjs` to preserve a synchronous boundary. The async pool runtime slice removed that worker and moved S3 PUT/GET/DELETE to async `fetch`.
- `scripts/gateway-service.mjs` supports `GATEWAY_ARTIFACT_STORE=s3`.
- `docker-compose.gateway-smoke.yml` runs the gateway with Postgres plus MinIO-backed S3 artifact storage.
- `scripts/gateway-smoke.mjs` can assert S3 storage URIs, S3 download handles, checksums, content type, restart durability, and artifact download content.
- `docs/s3-artifact-store.md` documents the contract and local verification flow.

## Verification

Run:

```bash
npm test
docker compose -f docker-compose.gateway-smoke.yml up -d --build
POSTGRES_URL=postgres://partners:partners@127.0.0.1:15432/partners \
S3_ENDPOINT=http://127.0.0.1:19000 \
S3_BUCKET=partners-artifacts \
S3_REGION=us-east-1 \
S3_ACCESS_KEY_ID=partners \
S3_SECRET_ACCESS_KEY=partners-secret \
  npm test
SMOKE_CHECK_DEPENDENCIES=1 \
SMOKE_EXPECT_ARTIFACT_BACKEND=s3 \
SMOKE_RESTART_COMMAND="docker compose -f docker-compose.gateway-smoke.yml restart gateway" \
  npm run gateway:smoke
docker compose -f docker-compose.gateway-smoke.yml down -v
```

## Limits

This handoff is historical. Production throughput work was completed in
`docs/slices/2026-07-05-async-pool-runtime.md`, which moved S3 artifact storage
to async gateway calls without per-request worker processes.
