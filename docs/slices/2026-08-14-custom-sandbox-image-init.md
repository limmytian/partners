# Custom sandbox image and bootstrap validation

Status: implementation and local release smoke complete; real Kubernetes
staging validation remains blocked until a Partners staging deployment and
credentialed image/Secret fixtures are provisioned.

## Delivered

- Provider-neutral `sandbox` request/response contract in the provider contract,
  OpenAPI, Task Weaver bridge, and API documentation.
- Immutable digest and Registry/profile policy checks; raw registry credentials,
  bearer tokens, passwords, and private keys are rejected.
- Kubernetes per-profile/per-job Pod image selection, SecretRef mapping,
  `imagePullPolicy`, architecture selector, standard sandbox-agent contract,
  bootstrap files/argv/env/timeout, cancellation, failure cleanup, and
  `sandbox.init.*` audit events.
- Session init hash/version/idempotency persistence on Pod and PVC annotations;
  recovery after Pod deletion does not repeat a successful bootstrap.

## Automated evidence

```text
npm test
74 tests, 72 passed, 2 skipped (live Postgres/MinIO integration tests)

SMOKE_CHECK_DEPENDENCIES=1 \
SMOKE_EXPECT_ARTIFACT_BACKEND=s3 \
SMOKE_RESTART_COMMAND="docker compose -f docker-compose.gateway-smoke.yml restart gateway" \
npm run gateway:smoke
```

The compose smoke completed all checks, including Postgres/MinIO readiness,
authentication bounds, custom sandbox contract acceptance with a synthetic
immutable digest and SecretRef, artifact download, SSE replay, cancellation,
metrics, and restart durability. The local provider intentionally does not
execute Kubernetes bootstrap; the smoke therefore does not claim image-pull or
PVC execution evidence.

## Staging gate

The available Kubernetes context was reachable and had `gvisor`, but no
`partners` or `partners-sandbox` namespace workloads, Services, PVCs, or
credentialed custom image fixtures. A staging rollout cannot be performed
safely without those platform-owned inputs. Do not mark the production
admission checkbox or publish a digest until the following are supplied:

1. an allowlisted immutable custom sandbox image digest and matching
   namespace-local pull Secret;
2. `PARTNERS_K8S_ALLOWED_REGISTRIES`, profile JSON, and agent Secret injected
   through the staging secret manager;
3. a staging gateway deployment using `GATEWAY_PROVIDER=kubernetes` and the
   intended ordinary/gVisor RuntimeClass;
4. evidence for ephemeral and PVC session init success/failure/timeout/
   cancellation, image-pull failure, Pod recreation, rollback, and redacted
   events.

Until then the final execution slice is `in_review` rather than falsely marked
done. The implementation commits are on `main` and are safe to validate when
the staging fixtures exist.
