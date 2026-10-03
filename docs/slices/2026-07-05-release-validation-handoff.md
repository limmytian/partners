# Release Validation Evidence Handoff

Date: 2026-07-05

Status: local release validation complete. Credentialed shared-registry and real
staging/production Kubernetes validation remain open operational work.

Validated branch: `main`

Latest commit at handoff: `b4c4098`

Primary validation tag: `validation-169d25e`

## Summary

Local release validation passed through image build, container startup, unit
tests, compose smoke, Postgres/S3-backed gateway smoke, and restart durability.

Registry push and Kubernetes rollout were later completed through the local
fallback path using a Docker `registry:2` container and a single-node `kind`
cluster. See `docs/slices/2026-07-05-release-registry-k8s-local.md`.

## Commits Produced During Validation

- `c6e3d8d` - `Validate local gateway release path`
  - Fixed an HTTP acceptance race for explicit job ids with async stores.
  - Added regression coverage with a slow `saveJob` store.
  - Added local release validation evidence.
- `b4c4098` - `Document release rollout blockers`
  - Documented registry credential and Kubernetes environment blockers.
- Follow-up local validation - `Local registry and Kubernetes rollout validation`
  - Validated local registry push/pull/digest lookup.
  - Validated `kind` deploy, `/health`, `/ready`, `/metrics`, rollout, rollback,
    and post-rollback recovery.

## Commands and Results

```bash
IMAGE_TAG=validation-169d25e bash scripts/gateway-release.sh build
```

Result: passed.

- Image: `ghcr.io/limmytian/partners-gateway:validation-169d25e`
- Local image id:
  `sha256:59c6485110bb4dc95914c331c605af6402deab049c2e03691c6bf96c1b469cb1`
- Runtime user: `node`
- Runtime process user during container validation: UID `1000`
- Healthcheck: configured for `/health` on port `8080`
- Labels: OCI title, description, version, revision, created timestamp, and
  source URL are present
- Container startup checks:
  - `/health` returned `{"status":"ok"}`
  - `/ready` returned `{"status":"ready","store":"memory","artifactStore":"local"}`
  - Docker health status reached `healthy`

```bash
npm test
```

Result: passed.

- 62 tests total
- 60 passed
- 2 skipped because live `POSTGRES_URL` and `S3_ENDPOINT` were not set

```bash
IMAGE_TAG=validation-169d25e npm run gateway:ci-smoke
```

Result: passed after fixing the explicit job id acceptance race.

The compose smoke path validated:

- Docker Compose build of `partners-gateway-smoke:validation-169d25e`
- Postgres service health
- MinIO service readiness and bucket bootstrap
- full repository unit test suite
- gateway `/health`
- gateway `/ready`
- auth rejection for missing token
- tenant/project authorization rejection
- session lifecycle
- successful job lifecycle
- SSE replay with `Last-Event-ID`
- S3 artifact manifest and download
- `/metrics`
- running job cancellation
- gateway restart
- restart durability for jobs, events, artifact manifests, and downloads
- compose cleanup of containers, network, and volumes

## Issue Found

The first compose smoke run failed at `cancel running job` with:

```text
HTTP status {"error":"Job was not accepted"}: expected 202, got 500
```

Root cause: the HTTP route did not wait for a caller-supplied job id to become
visible in the async store before checking acceptance. This could happen with
the Postgres store under real HTTP smoke timing.

Fix committed in `c6e3d8d`:

- `POST /v1/jobs` now waits for explicit ids and generated ids through the same
  acceptance polling path.
- Background completion promises attach an immediate rejection handler to avoid
  transient unhandled rejections before validation errors are returned.
- `test/http-agent-execution-gateway.test.js` covers the slow-store acceptance
  path.

## Registry Status

Follow-up result: passed through the local registry fallback.

See `docs/slices/2026-07-05-release-registry-k8s-local.md` for digest evidence:

- Image: `localhost:5001/partners-gateway:local-k8s-0df72a6`
- OCI index digest:
  `sha256:cfd09bf328a4e80bf8bf42776a4f93849fad57ef422ed53a6ae1f505cd06985d`

Attempted:

```bash
IMAGE_TAG=validation-169d25e bash scripts/gateway-release.sh push
docker manifest inspect ghcr.io/limmytian/partners-gateway:validation-169d25e
```

Result: blocked.

- Docker push failed with no basic auth credentials.
- Manifest inspect failed with no basic auth credentials.
- `REGISTRY_USER` and `REGISTRY_PASS` are unset.
- Docker credential store is configured through Docker Desktop, but no usable
  credential was available for `ghcr.io/limmytian`.
- No registry credentials were printed or committed.

No remote image digest is available because the push did not complete.

## Kubernetes Status

Follow-up result: passed through the local single-node `kind` fallback.

See `docs/slices/2026-07-05-release-registry-k8s-local.md` for deploy,
readiness, metrics, rollback, and post-rollback recovery evidence.

Checked:

```bash
kubectl config current-context
kubectl cluster-info
kubectl config get-contexts
```

Result: blocked.

- No current Kubernetes context is set.
- `KUBECONFIG` is unset.
- `kubectl cluster-info` falls back to `localhost:8080` and is refused.
- `kind`, `minikube`, and `k3d` are not installed, so a local single-node
  fallback cluster could not be created.

Manifest rendering works:

```bash
IMAGE_TAG=validation-169d25e bash scripts/gateway-release.sh render-manifest
```

Rendered deployment image:

```text
ghcr.io/limmytian/partners-gateway:validation-169d25e
```

The original staging deploy was blocked because no cluster was available. The
local fallback validation now covers deploy, readiness probe checks, rollout
status, rollback, and post-rollback service recovery.

## Next Operational Steps

1. Provide a Docker credential or `REGISTRY_USER`/`REGISTRY_PASS` with push and
   pull access to `ghcr.io/limmytian/partners-gateway`.
2. Re-run:

   ```bash
   IMAGE_TAG=validation-169d25e bash scripts/gateway-release.sh push
   docker manifest inspect ghcr.io/limmytian/partners-gateway:validation-169d25e
   ```

3. Provide a staging Kubernetes context, or install and approve use of
   `kind`, `minikube`, or `k3d` for local rollout validation.
4. Provide safe test values for `partners-gateway-secrets`:
   `POSTGRES_URL`, `GATEWAY_SERVICE_TOKEN`, `S3_ACCESS_KEY_ID`, and
   `S3_SECRET_ACCESS_KEY`.
5. Re-run deploy and rollback validation:

   ```bash
   IMAGE_TAG=validation-169d25e bash scripts/gateway-release.sh deploy
   bash scripts/gateway-release.sh rollback
   ```

6. For production release, repeat the push and rollout against the credentialed
   registry and staging/production Kubernetes context.
