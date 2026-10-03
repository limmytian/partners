# Credentialed Registry and Staging Kubernetes Validation

Date: 2026-08-13

Status: complete for the real staging publish, Postgres/S3-backed gateway,
Kubernetes-native sandbox, JuiceFS PVC persistence, rollout, and rollback.
Secrets and temporary dependency credentials were kept outside the repository.

## Environment

- Kubernetes context: `default`
- Node: `ser7`, `Ready`, Kubernetes `v1.36.3+k3s1`, containerd
  `2.3.2-k3s2`, `amd64`
- Registry: `ghcr.io/limmytian` (credentialed pull/push)
- Gateway namespace: `partners`
- Sandbox namespace: `partners-sandbox` with restricted Pod Security
- RuntimeClass: `gvisor` (`runsc` handler)
- Session storage class: `juicefs-rustfs` (`csi.juicefs.com`)

## Published images

The immutable validation tag was
`slice-registry-k8s-20260813-full-amd64` for the sandbox and
`slice-registry-k8s-20260813-amd64` for the gateway:

| Image | Digest | Verification |
| --- | --- | --- |
| `ghcr.io/limmytian/partners-gateway:slice-registry-k8s-20260813-amd64` | `sha256:e8fced18bdbcb5b6a4aca92cf5e6c96e66b6eb21ef61c9f65b5e219d8ac040fa` | amd64 image import and K3s rollout |
| `ghcr.io/limmytian/partners-sandbox:slice-registry-k8s-20260813-full-amd64` | `sha256:099ea49b14da038f5982f8c68147f25da6fab779670032c24b5b29d67803bab3` | amd64 image with `bash`, `git`, and `python3`; agent smoke |

`gateway-release.sh` now accepts `DOCKER_PLATFORM` so cross-architecture
builds are explicit and repeatable.

## Validation results

With a temporary Docker Desktop Postgres 15 and MinIO service reachable from
the staging node, the live suite passed **70/70 tests**, including the live
Postgres and MinIO cases. `gateway-smoke.mjs` passed:

- `/health`, `/ready`, and Prometheus `/metrics`
- dependency readiness, missing-token denial, and out-of-scope tenant denial
- session lifecycle and ephemeral job lifecycle
- SSE replay, S3 artifact manifest/download, and cancellation
- sandbox execution using `bash`, `git`, and `python3`

The gateway rollout used the published digest above. Sandbox Pods were
scheduled on `ser7`, selected `runtimeClassName: gvisor`, and reached Ready
through the private ClusterIP Service.

## JuiceFS persistence and rollback

Session `ses_release_persistence_20260813` received a workspace file through a
`workspace_session` job. Its PVC was Bound with storage class `juicefs-rustfs`
and capacity `3Gi`. After `gateway-release.sh rollback` moved the deployment to
`9c0f2d8-amd64` (gateway digest
`sha256:c5faeac3e3f2a07713bf1ff462f1227dcede9cc176993183c4f79e71bcbb0c21`), a
second job through the recovered session read the file back successfully. The
new validation image was then rolled out again and `/health`/`/ready` returned
healthy.

The first ephemeral job attempt found a Service/DNS propagation race and
returned `fetch failed` immediately after the Pod became Ready. The provider
now performs a bounded agent health wait before sending inputs or commands;
the regression is covered by `test/kubernetes-sandbox-provider.test.js`.

## Reproduction commands

```bash
DOCKER_PLATFORM=linux/amd64 IMAGE_TAG=<tag> \
  bash scripts/gateway-release.sh build
IMAGE_TAG=<tag> bash scripts/gateway-release.sh push
IMAGE_TAG=<tag> bash scripts/gateway-release.sh deploy
bash scripts/gateway-release.sh rollback
```

Do not put Registry, Postgres, S3, or agent-secret values in Git, Task Weaver,
logs, or this evidence file.
