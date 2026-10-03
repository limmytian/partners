# Gateway Release

Status: packaging plus repository-owned Kubernetes deploy/rollback flow. Live
staging evidence remains recorded in
`docs/slices/2026-08-13-release-registry-k8s-staging.md`.

For runtime selection, image distribution, diagnostics, and production
admission criteria, use [the Kubernetes runtime runbook](kubernetes-runtime-runbook.md).

Reviewed on: 2026-08-13

The packaging/deployment ownership contract is documented in
[`release-packaging-deployment-boundary.md`](release-packaging-deployment-boundary.md).

## Image

Build the gateway image:

```bash
IMAGE_REPOSITORY=ghcr.io/limmytian/partners-gateway \
IMAGE_TAG=$(git rev-parse --short HEAD) \
  bash scripts/gateway-release.sh build
```

`Dockerfile.gateway` installs production dependencies only, runs as the `node`
user, exposes `/health` as the image healthcheck, and writes OCI labels for
title, source, revision, image tag, and build date.

When the target Kubernetes nodes use a different architecture from the build
host, set `DOCKER_PLATFORM` for both images so the manifest is pulled by the
intended CRI:

```bash
DOCKER_PLATFORM=linux/amd64 \
IMAGE_TAG=<tag> \
  bash scripts/gateway-release.sh build
```

The same variable is honored by `build-sandbox`. Verify the pushed digest and
node architecture before deploying; an architecture-only image is rejected by
containerd with `no match for platform in manifest`.

## CI Smoke

Run the local release gate:

```bash
npm run gateway:ci-smoke
```

The target builds the compose image, starts Postgres and MinIO, waits for
gateway readiness, runs `npm test`, runs `npm run gateway:smoke`, restarts the
gateway, verifies durable job/event/artifact reads, prints service logs on
failure, and tears the stack down.

## Push

```bash
REGISTRY_USER=<user> \
REGISTRY_PASS=<password> \
IMAGE_REPOSITORY=ghcr.io/limmytian/partners-gateway \
IMAGE_TAG=<tag> \
  bash scripts/gateway-release.sh push
```

The login step is skipped when registry credentials are not set.

## Kubernetes Deploy

Before deploy, provision `partners-gateway-secrets` through the cluster secret
manager or a sealed-secret flow. The checked-in manifest never creates or
updates this Secret, and the deploy script verifies all required keys without
printing their values.

Deploy an immutable paired release through the repository script:

```bash
K8S_CONTEXT=<context> \
IMAGE_REPOSITORY=ghcr.io/limmytian/partners-gateway \
SANDBOX_IMAGE_REPOSITORY=ghcr.io/limmytian/partners-sandbox \
IMAGE_TAG=<tag> \
GATEWAY_IMAGE_DIGEST=sha256:<gateway-digest> \
SANDBOX_IMAGE_DIGEST=sha256:<sandbox-digest> \
  bash scripts/gateway-release.sh deploy
```

The script checks the explicit context, external Secret, Registry references,
StorageClass, RuntimeClass (when selected), ServiceAccount and sandbox RBAC;
then it performs a server-side dry-run, applies the non-Secret resources,
waits for `deployment/partners-gateway`, verifies the configured and running
image digest, and checks `/health`, `/ready`, and `/metrics` through a temporary
port-forward. `DEPLOY_MODE=local` is available for non-production tag-only
testing; production mode rejects mutable `latest` and missing digests.

## Rollback

```bash
K8S_CONTEXT=<context> \
ROLLBACK_GATEWAY_IMAGE_DIGEST=sha256:<previous-gateway-digest> \
  bash scripts/gateway-release.sh rollback
```

Rollback uses `kubectl rollout undo deployment/partners-gateway` (or the
previous ReplicaSet), waits for the deployment, optionally verifies the
previous immutable digest, and repeats the health, sandbox, artifact, and
session smoke. It never changes the external Secret.

Run the same post-rollout checks without changing resources:

```bash
K8S_CONTEXT=<context> bash scripts/gateway-release.sh staging-smoke
```

## Full Release

```bash
IMAGE_REPOSITORY=ghcr.io/limmytian/partners-gateway \
IMAGE_TAG=<tag> \
REGISTRY_USER=<user> \
REGISTRY_PASS=<password> \
  npm run gateway:release
```

This runs `test`, `compose-smoke`, `build`, and `push` in order. Deployment is
an explicit follow-up command so the packaging lane cannot select a cluster or
change runtime state.
