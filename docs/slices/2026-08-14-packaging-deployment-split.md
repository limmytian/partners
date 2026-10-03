# Packaging and Deployment Split Evidence

Date: 2026-08-14

This slice records the verification state of the split release flow. It records
commands, statuses, tags, and digests only; no Registry, Postgres, S3, or agent
Secret values belong in this document.

## Delivered commits

The implementation was committed and pushed directly to `main` after each
completed slice:

| Slice | Commit | Result |
| --- | --- | --- |
| Boundary and acceptance contract | `827c874` | Jenkins/repository ownership, paired image metadata, Secret boundary, and acceptance contract |
| Jenkins packaging | `dd62d07` | buildx multi-arch gateway/sandbox pipeline and archived digest metadata |
| Repository deploy and rollback gates | `3aee0ae` | external Secret preflight, digest-only production deploy, rollout/image/health checks, smoke and rollback |

## Local verification

| Check | Status | Evidence |
| --- | --- | --- |
| `bash -n scripts/gateway-release.sh` | PASS | Release entrypoint parses after the deployment/smoke changes |
| `git diff --check` | PASS | No whitespace errors in the delivered commits |
| `npm test` | PASS | 79 tests: 77 passed, 2 live Postgres/MinIO tests skipped because their environment variables were unset |
| Production render without digests | PASS (rejected) | Missing `GATEWAY_IMAGE_DIGEST` is rejected before manifest output |
| Digest render and Secret safety | PASS | Paired `repo:tag@sha256:<digest>` images render; placeholders, `kind: Secret`, and `replace-me` values are absent |
| Local tag render | PASS | `DEPLOY_MODE=local` keeps tag-only rendering for non-production testing |
| Unknown Kubernetes context | PASS (rejected) | Deploy fails before apply when `K8S_CONTEXT` is not configured |
| `npm run gateway:ci-smoke` | BLOCKED | The local Docker daemon was unavailable at `unix:///Users/mini/.docker/run/docker.sock`; Compose did not start |

The Compose smoke block is environmental, not a test failure. Re-run it on a
host with Docker running before accepting a release candidate:

```bash
npm run gateway:ci-smoke
```

## Jenkins verification

The repository now contains a packaging-only `Jenkinsfile`. A real Jenkins run
was not executed from this workstation because it requires the Jenkins job and
registry credential binding. The first Jenkins run must prove:

1. checkout is the intended `main` revision;
2. both `Dockerfile.gateway` and `Dockerfile.sandbox` build for
   `linux/amd64,linux/arm64` with registry cache;
3. both images use the same short-SHA tag and are pushed successfully;
4. `release-metadata-<tag>.json` contains the full source SHA, platform list,
   and both manifest-list digests;
5. the job performs no Kubernetes or deployment operation.

The metadata artifact is the handoff to the repository deployment lane. Keep
the gateway and sandbox digests paired; do not select one from a different
Jenkins build.

## Staging verification procedure

Run these steps with a context explicitly selected by the operator. Provision
the external Secret before step 1; the repository manifest never creates it.

```bash
# Values come from the archived Jenkins metadata artifact.
export K8S_CONTEXT=<staging-context>
export IMAGE_TAG=<short-sha-tag>
export GATEWAY_IMAGE_DIGEST=sha256:<gateway-digest>
export SANDBOX_IMAGE_DIGEST=sha256:<sandbox-digest>

bash scripts/gateway-release.sh deploy
bash scripts/gateway-release.sh staging-smoke

# Use the previous digest when it is available; rollout revision is the fallback.
ROLLBACK_GATEWAY_IMAGE_DIGEST=sha256:<previous-gateway-digest> \
  bash scripts/gateway-release.sh rollback
```

`deploy` performs Secret-key, Registry-reference, StorageClass, RuntimeClass,
ServiceAccount, and sandbox RBAC preflight; server-side dry-run; apply; rollout
status; Deployment image and service-account/Secret-reference checks; running
Pod imageID verification; and `/health`, `/ready`, `/metrics` checks. The full
smoke then exercises the sandbox agent, session lifecycle, artifact listing and
download, cancellation, SSE replay, and metrics. Set
`K8S_SMOKE_RESTART_COMMAND` to a reviewed restart command when restart
durability is part of the staging gate.

Rollback must leave the external Secret untouched. It uses
`kubectl rollout undo` and repeats the same health/smoke checks; when
`ROLLBACK_GATEWAY_IMAGE_DIGEST` is supplied, the running Pod imageID must match
that digest.

## Production admission checklist

- [ ] Jenkins packaging completed for the exact source revision.
- [ ] Gateway and sandbox metadata contain the same source tag and two recorded
      manifest-list digests.
- [ ] Compose Postgres/MinIO smoke passed on a Docker-enabled runner.
- [ ] External Secret was provisioned by the environment secret manager and all
      required keys were checked without exposing values.
- [ ] Staging deploy, full smoke, rollback, and post-rollback smoke passed.
- [ ] The production context and previous rollback digest/revision are written
      in the change record.
- [ ] No credential, mutable `latest` reference, or unreviewed context appears
      in Jenkins logs, metadata, manifests, or Task Weaver records.

Until the Compose and live staging rows above are rerun successfully with this
new flow, this evidence is not a production approval.

