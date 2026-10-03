# Custom sandbox image and bootstrap contract

This document freezes the provider-neutral contract for the custom sandbox
image and initialization work. It is the design baseline for the Kubernetes
provider implementation in the next execution slice.

## Request shape

`CreateSessionRequest` and `CreateJobRequest` accept an optional `sandbox`:

```json
{
  "sandbox": {
    "profile": "python-tools",
    "image": "ghcr.io/limmytian/partners/python-tools@sha256:<64 hex chars>",
    "imagePullSecretRef": "platform://registry/partners",
    "imagePullPolicy": "IfNotPresent",
    "architecture": "amd64",
    "agentContract": { "port": 8081, "workspacePath": "/workspace" },
    "init": {
      "files": [{ "path": "/workspace/.config", "content": "..." }],
      "argv": ["/workspace/bootstrap.sh"],
      "env": { "BOOTSTRAP_VERSION": "2026-08-13" },
      "timeoutSeconds": 120,
      "idempotencyKey": "session-bootstrap-v1",
      "version": "v1"
    }
  }
}
```

Omitting `sandbox` preserves the existing provider image and behavior. A
session's configuration is the default for jobs using that session; a job may
provide an explicitly authorized override. `snapshot` remains a separate
compatibility input and is not treated as an image or credential reference.

## Image and credential policy

- `image` is an explicit registry reference pinned to
  `@sha256:<64 lowercase hexadecimal characters>`. The provider resolves the
  registry allowlist and profile authorization before creating a Pod.
- The allowlist is matched against the registry hostname (including an
  explicit port when present). Bare Docker Hub names are not accepted for a
  custom image.
- `imagePullSecretRef` is an opaque, platform-owned reference. The request may
  not contain a Secret value, registry auth JSON, bearer token, password, or
  private key. Trusted provider code maps the reference to a Kubernetes
  `imagePullSecrets` entry.
- The standard image contract is port `8081`, `/health`,
  `/v1/files/write`, `/v1/files/read`, `/v1/exec`, `/v1/cancel`, and a writable
  `/workspace`. Images run non-root with privilege escalation disabled and
  all Linux capabilities dropped, regardless of the selected profile.

## Initialization lifecycle

Initialization runs after the agent health check and before the user's main
command. Files are constrained to `/workspace`; each file supplies exactly one
of `content` or `contentBase64`. `argv` is executed through the agent API with
the declared `env` and a maximum 15-minute timeout. Non-zero exit, timeout, or
cancellation prevents the session/job from entering its normal ready/running
state. Ephemeral resources are cleaned up on failure.

For a persistent session, the provider records the init version and/or
idempotency key in session state. A successful init is not repeated after a Pod
restart or PVC reattachment unless the requested version/key changes. Init
stdout/stderr is treated as sensitive execution output: events and errors are
redacted before leaving the gateway and never contain credential material.

The implementation is intentionally additive. Existing callers that only send
`command`, `code`, `inputs`, and the current resource/network fields remain
valid and continue to use the default sandbox image.
