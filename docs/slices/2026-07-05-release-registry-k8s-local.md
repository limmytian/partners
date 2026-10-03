# Local Registry and Kubernetes Rollout Validation

Date: 2026-07-05

Validated branch: `main`

Source commit used for image build: `0df72a6`

This completes the registry push/pull and Kubernetes deploy/rollback slice with
a local Docker registry and a local single-node `kind` cluster. The shared
`ghcr.io/limmytian` registry still needs real credentials for a production
push, but the release script, image pullability, rendered manifest, rollout, and
rollback paths were validated end to end.

## Local Environment

- Docker: `29.5.3`
- `kind`: `v0.32.0 go1.26.3 darwin/arm64`
- `kubectl` client: `v1.34.1`
- Kubernetes node image: `kindest/node:v1.36.1`
- Cluster: `partners-validation`
- Registry container: `partners-validation-registry`
- Registry endpoint from host: `localhost:5001`
- Registry endpoint from `kind` network: `http://partners-validation-registry:5000`

Temporary resources were removed after validation:

```bash
kind delete cluster --name partners-validation
docker rm -f partners-validation-registry
```

## Registry Validation

Built the gateway image from the current `main` commit using the existing
release script:

```bash
IMAGE_REPOSITORY=localhost:5001/partners-gateway \
IMAGE_TAG=local-k8s-0df72a6 \
  bash scripts/gateway-release.sh build
```

Pushed it through the existing release script:

```bash
IMAGE_REPOSITORY=localhost:5001/partners-gateway \
IMAGE_TAG=local-k8s-0df72a6 \
  bash scripts/gateway-release.sh push
```

Verified pullability:

```bash
docker pull localhost:5001/partners-gateway:local-k8s-0df72a6
```

Result: passed.

- Image: `localhost:5001/partners-gateway:local-k8s-0df72a6`
- OCI index digest:
  `sha256:cfd09bf328a4e80bf8bf42776a4f93849fad57ef422ed53a6ae1f505cd06985d`
- Linux arm64 manifest digest:
  `sha256:c16cfa4a4e6a9258e3871dab84856dcf83f7311dcbcd8f3af7d6cc91e734fe11`
- Registry HTTP `HEAD /v2/partners-gateway/manifests/local-k8s-0df72a6`
  returned `200 OK` and the same `Docker-Content-Digest`.
- `docker image inspect` recorded the repo digest:
  `localhost:5001/partners-gateway@sha256:cfd09bf328a4e80bf8bf42776a4f93849fad57ef422ed53a6ae1f505cd06985d`

No registry credentials were used or written to logs.

## Kubernetes Deploy Validation

Rendered the checked-in manifest with the local registry image:

```bash
IMAGE_REPOSITORY=localhost:5001/partners-gateway \
IMAGE_TAG=local-k8s-0df72a6 \
  bash scripts/gateway-release.sh render-manifest
```

For local validation only, the rendered `/tmp` manifest changed the backing
stores from production-style dependencies to self-contained local stores:

```yaml
GATEWAY_STORE: "memory"
GATEWAY_ARTIFACT_STORE: "local"
```

The checked-in `k8s/k8s-partners-gateway.yaml` was not changed.

Applied resources:

```text
namespace/partners created
configmap/partners-gateway-config created
secret/partners-gateway-secrets created
deployment.apps/partners-gateway created
service/partners-gateway created
```

Rollout result:

```text
deployment "partners-gateway" successfully rolled out
partners-gateway-5884887978-qgr58   1/1   Running   0   10.244.0.5
```

Service checks through `kubectl port-forward svc/partners-gateway 18082:8080`:

```json
{"status":"ok"}
{"status":"ready","store":"memory","artifactStore":"local"}
```

Metrics endpoint sample:

```text
partners_gateway_uptime_seconds 21
partners_gateway_http_requests_total 6
partners_gateway_http_request_duration_ms_total 6
partners_gateway_http_requests_by_status_total{status_class="2xx"} 6
partners_gateway_http_requests_by_route_total{route="get__health"} 3
partners_gateway_http_requests_by_route_total{route="get__ready"} 3
```

## Rollback Validation

Tagged and pushed the same image under a second test tag to create a real
Deployment revision:

```bash
docker tag \
  localhost:5001/partners-gateway:local-k8s-0df72a6 \
  localhost:5001/partners-gateway:local-k8s-0df72a6-rollout2
docker push localhost:5001/partners-gateway:local-k8s-0df72a6-rollout2
kubectl -n partners set image deployment/partners-gateway \
  gateway=localhost:5001/partners-gateway:local-k8s-0df72a6-rollout2
```

Rollout result:

```text
deployment "partners-gateway" successfully rolled out
after_rollout_image=localhost:5001/partners-gateway:local-k8s-0df72a6-rollout2
```

Rollback command:

```bash
bash scripts/gateway-release.sh rollback
```

Rollback result:

```text
deployment.apps/partners-gateway rolled back
deployment "partners-gateway" successfully rolled out
after_rollback_image=localhost:5001/partners-gateway:local-k8s-0df72a6
```

Post-rollback readiness:

```text
deployment.apps/partners-gateway condition met
partners-gateway   10.244.0.7:8080
```

Post-rollback service checks:

```json
{"status":"ok"}
{"status":"ready","store":"memory","artifactStore":"local"}
```

Final pod state:

```text
partners-gateway-5884887978-tbh9v   1/1   Running   0   10.244.0.7
```

## Notes

- This validates the local fallback explicitly allowed by the release
  requirement when shared staging is unavailable.
- The remote production registry push remains a credentialed operational step
  for a real release, but it is no longer a blocker for validating the release
  script and Kubernetes rollout mechanics.
