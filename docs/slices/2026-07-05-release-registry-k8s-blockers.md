# Registry Push and Kubernetes Rollout Blockers

Date: 2026-07-05

Status: historical blocker record. A local registry and single-node `kind`
cluster later resolved the local validation path. Credentialed shared-registry
and real staging Kubernetes validation remain open.

Image intended for validation: `ghcr.io/limmytian/partners-gateway:validation-169d25e`

## Registry Push

Command attempted:

```bash
IMAGE_TAG=validation-169d25e bash scripts/gateway-release.sh push
```

Result: blocked.

Docker attempted to push `ghcr.io/limmytian/partners-gateway:validation-169d25e`
but the registry rejected the request:

```text
push access denied, repository does not exist or may require authorization: authorization failed: no basic auth credentials
```

Follow-up checks:

- `REGISTRY_USER` is unset.
- `REGISTRY_PASS` is unset.
- Docker Desktop credential store is configured, but no usable credentials were
  available for `ghcr.io/limmytian`.
- `docker manifest inspect ghcr.io/limmytian/partners-gateway:validation-169d25e`
  also failed with `no basic auth credentials`.

No registry credentials were printed or written to docs.

## Kubernetes Rollout

Commands checked:

```bash
kubectl config current-context
kubectl cluster-info
kubectl config get-contexts
```

Result: blocked.

- `kubectl config current-context` failed because no current context is set.
- `kubectl cluster-info` fell back to `localhost:8080` and was refused.
- `kubectl config get-contexts` returned no configured contexts.
- `KUBECONFIG` is unset.
- `kind`, `minikube`, and `k3d` are not installed on this machine, so a local
  single-node fallback cluster could not be created.

The manifest render path itself works:

```bash
IMAGE_TAG=validation-169d25e bash scripts/gateway-release.sh render-manifest
```

Rendered deployment image:

```text
ghcr.io/limmytian/partners-gateway:validation-169d25e
```

## Required Inputs To Finish

- A test registry account or preconfigured Docker credential for
  `ghcr.io/limmytian` with push/pull access to `partners-gateway`.
- A staging Kubernetes context, or permission to install and use a local
  single-node tool such as `kind`, `minikube`, or `k3d`.
- Safe test secret values for `partners-gateway-secrets`:
  `POSTGRES_URL`, `GATEWAY_SERVICE_TOKEN`, `S3_ACCESS_KEY_ID`, and
  `S3_SECRET_ACCESS_KEY`.

## Current Status

At the time this blocker note was written, the local image build and compose
smoke were already validated in
`docs/slices/2026-07-05-release-validation-local.md`, but registry push,
pullability/digest verification, Kubernetes deploy, and rollback remained
pending until more environment inputs were available.

## Follow-Up

The local fallback path requested by the release requirement has now been
validated with a Docker `registry:2` container and a single-node `kind` cluster.
See `docs/slices/2026-07-05-release-registry-k8s-local.md` for the completed
registry digest, deploy, probe, rollout, rollback, and cleanup evidence.
