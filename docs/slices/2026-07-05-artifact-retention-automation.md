# Artifact Retention Automation Slice

Date: 2026-07-05

Requirement: Implement artifact retention lifecycle automation.

## Scope

This slice turns retention guidance into executable policy and cleanup
automation for Postgres artifact manifests and S3-compatible object storage.
JuiceFS production cleanup remains deferred.

## Outputs

- `src/artifacts/artifact-retention.js` defines retention classes, TTLs, legal
  hold behavior, expiration evaluation, expired manifest selection, and S3
  lifecycle generation/validation.
- `PostgresGatewayStore` can list artifact manifests and delete a manifest after
  object cleanup succeeds.
- `S3ArtifactStore` writes object tags for `retentionClass`, `artifactId`, and
  `jobId`, enabling lifecycle rules by class.
- `scripts/gateway-retention-cleanup.mjs` supports:
  - `cleanup` for dry-run/default cleanup
  - `s3-policy` for lifecycle configuration output
  - `validate-s3-policy --file <path>` for rule validation
- `docs/artifact-retention.md` documents policy, cleanup order, lifecycle rules,
  and JuiceFS deferral.

## Safety

Cleanup is dry-run by default. Destructive cleanup deletes the backing object
first and the Postgres manifest second. Operators can set
`RETENTION_ASSUME_OBJECT_LIFECYCLE=1` only when bucket lifecycle owns object
deletion, and `RETENTION_ALLOW_MISSING_OBJECTS=1` only when missing objects are
expected.

## Verification

- `npm test`
- Retention unit tests cover class TTLs, legal hold, expired selection, and S3
  lifecycle validation.
- Postgres store tests cover manifest list/delete.
- S3 store tests assert retention tags are signed and sent.
- `npm run gateway:cleanup -- s3-policy`
