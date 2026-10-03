# Release Packaging and Deployment Boundary

Status: implementation contract for the split release flow.

Reviewed on: 2026-08-14

This document freezes the ownership boundary before the Jenkins and deployment
script changes land. It is deliberately free of credentials and cluster
endpoints that are not already part of the repository contract.

## Decision

Jenkins is the packaging lane. It checks out the requested revision, builds
both Partners images for the supported target architectures, logs in to the
container registry, pushes the images, and publishes the resulting image tags
and immutable digests as build metadata.

The repository is the deployment lane. An operator or an explicitly invoked
deployment job runs the repository scripts with an explicit Kubernetes context
and immutable image inputs. Those scripts own manifest rendering, preflight
checks, Secret validation, `kubectl apply`, rollout verification, staging
smoke, and rollback.

Jenkins must not run `kubectl`, select a Kubernetes context, create or update a
runtime Secret, apply a manifest, or perform a staging deployment. A Jenkins
build is successful only when both images have been pushed and their paired
metadata has been archived.

## Packaging contract (Jenkins)

Inputs:

- the source revision selected by the Jenkins build;
- the gateway and sandbox image repository names;
- registry credentials supplied by the Jenkins credential store;
- the target platform list, currently `linux/amd64,linux/arm64`.

Outputs:

- a gateway image and a sandbox image tagged with the same immutable source
  identifier (the full commit SHA is retained in metadata);
- the manifest-list digest for each pushed image;
- a machine-readable release metadata artifact containing the source SHA,
  image references, platform list, and both digests.

The two image references are a pair: deployment must not mix a gateway image
from one build with a sandbox image from another build. A mutable convenience
tag such as `latest` may be published for humans, but deployment uses the
paired tag and digest recorded by the build.

## Deployment contract (repository)

Deployment inputs are the paired gateway and sandbox image digests, an explicit
Kubernetes context/namespace, and a pre-created `partners-gateway-secrets`
Secret containing the keys consumed by the manifest. The deployment script must
fail before `kubectl apply` when the context, required Secret keys, or image
inputs are missing.

The deployment flow renders the manifest without credentials, applies only
non-secret resources, waits for the gateway rollout, verifies the running image
IDs and health endpoints, and records enough information to undo the rollout.
Rollback selects a previously recorded image pair (or the previous ReplicaSet)
and runs the same rollout and smoke checks. It must not rotate or overwrite
runtime credentials.

## Baseline audit and implementation result

The baseline implementation that motivated this split combined the two lanes:

- `scripts/gateway-release.sh build` uses `docker build` and an optional single
  `DOCKER_PLATFORM`; it does not produce a multi-architecture manifest.
- `scripts/gateway-release.sh push` logs in and pushes both images, but it does
  not emit paired digest metadata.
- `scripts/gateway-release.sh deploy` rendered and applied the complete
  `k8s/k8s-partners-gateway.yaml` and waited for rollout.
- `scripts/gateway-release.sh release` chained tests, compose smoke, build,
  push, and deploy in one command.
- The Kubernetes manifest currently contains a `Secret` with `replace-me`
  placeholders. Applying that object can overwrite a live Secret and must be
  removed from the deployable manifest; Secret creation belongs to the
  environment's secret-management process.
- The baseline rollback command used `kubectl rollout undo` without paired
  image verification or a post-rollback smoke check.

The implementation delivered by this requirement now enforces the contract:

- `Jenkinsfile` builds and pushes both images with buildx, then archives paired
  manifest-list digests; it contains no deployment stage.
- `gateway-release.sh` defaults to digest-only production deployment, requires
  an explicit Kubernetes context, and checks external Secret keys,
  StorageClass, RuntimeClass, ServiceAccount, and sandbox RBAC before apply.
- The Kubernetes manifest contains no Secret object. Deployment performs a
  server-side dry-run, rollout/image/health checks, and the full repository
  smoke; rollback can verify a previous digest or rollout revision and repeats
  smoke.
- The `release` command is packaging-only. Deployment is an explicit follow-up
  so a packaging job cannot change cluster state.

## Slice acceptance and migration order

The slices are intentionally ordered so each later change has a stable
contract to target:

1. this boundary, audit, and acceptance contract;
2. a Jenkins packaging pipeline that builds and pushes both images with
   buildx, then archives paired metadata;
3. repository deployment, rollback, preflight, and Secret safety gates;
4. validation evidence and the operator runbook.

For this contract slice, the non-cluster acceptance checks are:

```bash
bash -n scripts/gateway-release.sh
npm test
npm run gateway:ci-smoke
IMAGE_REPOSITORY=ghcr.io/limmytian/partners-gateway \
IMAGE_TAG=<tag> bash scripts/gateway-release.sh render-manifest >/tmp/partners-gateway.yaml
```

The render check must not contain real credentials. No live deployment is part
of this slice.
