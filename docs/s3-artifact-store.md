# S3 ArtifactStore

Status: implemented for async S3-compatible storage and MinIO smoke verification.

`S3ArtifactStore` is the object-storage backend for gateway artifacts. It keeps
the same public manifest shape as `LocalArtifactStore`, but writes bytes to an
S3-compatible bucket and exposes gateway-mediated download handles.

The runtime uses async `fetch` directly. It no longer forks a short-lived worker
process for each PUT, GET, or DELETE, which lets the gateway apply normal
request backpressure and shutdown behavior around in-flight artifact operations.

## Contract

The store accepts artifact records with inline `content`, `contentBase64`, or a
provider-local `localPath`. `writeArtifact`, `readArtifact`, and
`deleteArtifact` are async. `createSignedDownloadUrl` is synchronous because it
only signs metadata locally. The public manifest includes:

- `id`, `jobId`, `kind`, `name`, `contentType`, `sizeBytes`, and `sha256`
- `storageUri` in the form `s3://<bucket>/<key>`
- `downloadHandle` in the form `artifact://s3/<artifactId>`
- `retentionClass`, `metadata.s3.bucket`, `metadata.s3.key`, `metadata.s3.region`, and `createdAt`

The public record never includes provider workspace paths, gateway temporary
paths, raw credentials, or implementation-local filesystem paths.

S3 objects are written with tags for `retentionClass`, `artifactId`, and `jobId`.
The retention lifecycle generator uses those tags to produce class-specific
bucket rules. See [artifact-retention.md](artifact-retention.md).

## Object Key Layout

Default key layout:

```text
gateway-artifacts/<jobId>/<artifactId>/<sanitized-name>
```

Configure the prefix with `S3_PREFIX`. Names and path segments are sanitized so
callers cannot escape the prefix or create ambiguous object paths.

## Gateway Downloads

Gateway HTTP downloads remain mediated by:

```text
GET /v1/artifacts/{artifactId}/download
```

The gateway loads the artifact manifest from `GatewayStore`, asks
`S3ArtifactStore` to read the object by `artifact://s3/<artifactId>`, and streams
bytes back to the caller after authorization. `S3ArtifactStore` also supports
creating presigned GET URLs for future direct-download flows, but the local
smoke harness uses the gateway-mediated path.

## Configuration

`scripts/gateway-service.mjs` selects the backend with:

```bash
GATEWAY_ARTIFACT_STORE=s3
S3_ENDPOINT=http://minio:9000
S3_BUCKET=partners-artifacts
S3_REGION=us-east-1
S3_PREFIX=gateway-artifacts
S3_ACCESS_KEY_ID=partners
S3_SECRET_ACCESS_KEY=partners-secret
```

The local compose smoke harness bootstraps the MinIO bucket before the gateway
starts.

## Verification

Run against the compose MinIO service:

```bash
docker compose -f docker-compose.gateway-smoke.yml up -d --build
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
