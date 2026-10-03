# Local Release Smoke and Image Build Handoff

Date: 2026-07-05

Status: historical local-build slice. The deferred registry and Kubernetes
mechanics were later completed through the local registry/`kind` fallback in
`docs/slices/2026-07-05-release-registry-k8s-local.md`; credentialed remote
registry and real staging validation remain open.

Commit under validation: `169d25e8a31528815c0fb0bdd717bb5f56f1fc45`

Image tag: `validation-169d25e`

## Commands Run

```bash
IMAGE_TAG=validation-169d25e bash scripts/gateway-release.sh build
```

Result: passed.

- Built `ghcr.io/limmytian/partners-gateway:validation-169d25e`.
- Image id: `sha256:59c6485110bb4dc95914c331c605af6402deab049c2e03691c6bf96c1b469cb1`.
- Build imported `./src/index.js` successfully inside the image.
- OCI labels included title, description, version, revision, created timestamp, and source URL.
- Runtime user is `node`.
- Healthcheck calls `http://127.0.0.1:8080/health`.
- Exposes `8080/tcp`.

```bash
docker run -d --name partners-gateway-validation -p 18081:8080 \
  -e GATEWAY_SERVICE_TOKEN=validation-token \
  -e GATEWAY_SERVICE_TOKEN_REF=validation \
  -e GATEWAY_SERVICE_SCOPES='*' \
  -e GATEWAY_TENANT_IDS=local \
  -e GATEWAY_PROJECT_IDS=partners \
  ghcr.io/limmytian/partners-gateway:validation-169d25e
```

Result: passed.

- `/health` returned `{"status":"ok"}`.
- `/ready` returned `{"status":"ready","store":"memory","artifactStore":"local"}`.
- Docker health status reached `healthy`.
- Process ran as UID `1000`, matching the non-root `node` user.
- Validation container was removed with `docker rm -f partners-gateway-validation`.

```bash
npm test
```

Result: passed.

- 62 tests total.
- 60 passed.
- 2 skipped because live `POSTGRES_URL` and `S3_ENDPOINT` were not set.

```bash
IMAGE_TAG=validation-169d25e npm run gateway:ci-smoke
```

Result: passed after fixing the acceptance race described below.

- Built compose image `partners-gateway-smoke:validation-169d25e`.
- Compose brought up gateway, Postgres, MinIO, and MinIO bootstrap.
- Repository unit tests passed inside the release smoke path.
- Gateway smoke checks passed:
  - gateway health
  - gateway readiness
  - Postgres TCP readiness
  - MinIO readiness
  - missing token denied
  - out-of-scope tenant forbidden
  - session lifecycle
  - successful job submission and terminal state
  - SSE replay
  - S3 artifact manifest and download
  - Prometheus metrics endpoint
  - running job cancellation
  - gateway restart
  - restart durability for jobs, events, artifacts, and downloads
- Compose cleanup removed containers, network, and volumes.

## Issue Found and Fixed

The first `gateway:ci-smoke` run failed at the `cancel running job` check:

```text
HTTP status {"error":"Job was not accepted"}: expected 202, got 500
```

Root cause: `POST /v1/jobs` skipped `waitForJobId` when the caller supplied an
explicit job id. With the Postgres store, `saveJob` is asynchronous, so the HTTP
route could check `getJob(id)` before the accepted job row was visible.

Fix:

- `POST /v1/jobs` now waits for explicit job ids to become visible through the
  same acceptance polling path used for generated ids.
- The route attaches an immediate rejection handler to the background completion
  promise so validation errors do not create transient unhandled rejections.
- Added HTTP regression coverage with a slow `saveJob` store.

## Deferred At This Snapshot

No registry push, digest verification, Kubernetes deploy, or rollback was run
in this slice. The local fallback completed those mechanics in
`docs/slices/2026-07-05-release-registry-k8s-local.md`; the remote production
track is listed in `docs/slices/2026-07-05-release-validation-handoff.md`.
