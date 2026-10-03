# Local ArtifactStore

Status: implemented for development fallback; S3ArtifactStore is available for object storage.

The local ArtifactStore is the gateway-side development fallback for copied-out
job artifacts. Providers may return temporary sandbox-local files, but the
gateway copies their bytes into a gateway-owned directory before indexing the
public artifact manifest.

## Contract

`LocalArtifactStore` accepts artifact records with inline `content`,
`contentBase64`, or a provider-local `localPath`. It returns a public manifest
record with:

- `id`, `jobId`, `kind`, `name`, `contentType`, `sizeBytes`, and `sha256`
- `storageUri` and `downloadHandle` in the form `artifact://local/<artifactId>`
- `retentionClass`, `metadata`, and `createdAt`

The public record does not include provider-local paths or gateway-local paths.
Only the store process keeps the filesystem path needed to read and delete the
payload.

## Gateway Wiring

`InMemoryAgentExecutionGateway` accepts an optional `artifactStore`. When
configured, provider artifacts are written through the store before the gateway
indexes them. `GET /v1/jobs/{jobId}/artifacts` returns the store manifest, and
`GET /v1/artifacts/{artifactId}/download` streams bytes through
`gateway.readArtifact(artifactId)`.

When no store is configured, the development HTTP adapter can still stream
provider-local artifacts for the in-process local provider. That fallback is not
the durable contract.

## Retention

The local store records a `retentionClass`, but it does not run a background TTL
sweeper. Development callers should delete artifacts with `deleteArtifact` or
clean the configured root directory between runs. `npm run gateway:cleanup`
keeps a local-file fallback mode for this backend when `POSTGRES_URL` is not
set. Hosted deployments should use the manifest-driven policy in
[artifact-retention.md](artifact-retention.md).

## Backend Swap

Object-storage or JuiceFS backends should preserve the same public
manifest fields and download semantics:

- copy bytes out of provider sandboxes before teardown
- keep workspace paths and storage implementation paths out of public manifests
- expose stable handles or signed URLs for downloads
- enforce deletion by artifact retention policy rather than workspace lifetime
