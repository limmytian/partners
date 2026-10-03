# Artifact Retention

Status: executable policy model and cleanup automation implemented.

Reviewed on: 2026-07-05

## Policy Model

Artifacts carry `retentionClass` in their public manifest. The default policy:

| Class | TTL | Cleanup behavior |
| --- | --- | --- |
| `transient` | 24 hours | Delete object, then manifest. |
| `review` | 7 days | Delete object, then manifest. |
| `audit` | 365 days | Delete object, then manifest after audit window. |
| `legal_hold` | none | Never delete automatically. |
| `forever` | none | Never delete automatically. |

`metadata.retention.legalHold=true` prevents deletion regardless of class.
`metadata.retention.expiresAt` can override the class TTL for a specific
artifact. Unknown classes are treated as `review`.

Deletion order is object first, manifest second. This avoids returning manifests
for bytes that have already been removed by gateway automation.

## Cleanup Command

Dry-run is the default:

```bash
npm run gateway:cleanup
```

With `POSTGRES_URL`, the command scans `gateway_artifacts`, evaluates manifests,
and reports expired candidates. To delete:

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

If the bucket lifecycle policy owns object deletion, set
`RETENTION_ASSUME_OBJECT_LIFECYCLE=1` before deleting manifests. If an object is
already gone and that is expected, set `RETENTION_ALLOW_MISSING_OBJECTS=1`.

Without `POSTGRES_URL`, the command preserves its local fallback behavior and
cleans old files under `GATEWAY_ARTIFACT_ROOT` by mtime.

## S3 Lifecycle

`S3ArtifactStore` writes object tags including `retentionClass`, `artifactId`,
and `jobId`. Generate an S3-compatible lifecycle configuration:

```bash
npm run --silent gateway:cleanup -- s3-policy > lifecycle.json
npm run gateway:cleanup -- validate-s3-policy --file lifecycle.json
```

The generated rules filter by object prefix and `retentionClass` tag. They skip
`legal_hold` and `forever`.

## JuiceFS

JuiceFS production validation remains deferred. Future JuiceFS cleanup should
preserve the same manifest-first scan, object-delete, then manifest-delete order
unless the storage backend owns lifecycle deletion independently.
