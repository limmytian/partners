# Agent Execution Gateway API

Status: v1 design draft

Reviewed on: 2026-08-13

## Goal

Expose a small product-facing API that lets Task Weaver and other services run sandboxed agent work without depending on Task Weaver internals or provider-specific concepts.

The API has two execution modes:

- `ephemeral_interpreter`: create a short-lived sandbox, inject inputs, run code or commands, stream events, collect outputs, then destroy the sandbox.
- `workspace_session`: create or reuse a longer-lived workspace for repository work, debugging, tests, previews, branches, and multi-step agent workflows.

## Principles

- Provider-neutral: callers request capabilities, not provider-specific operations.
- Idempotent creation: all mutating create calls accept `Idempotency-Key`.
- Event-first: logs, lifecycle changes, metrics, and artifact announcements are streamed through one event feed.
- Artifact durability: terminal jobs copy stdout, stderr, logs, patches, and declared files out of the sandbox before teardown.
- Gateway-owned lifecycle: the gateway database is authoritative for sessions and jobs; storage providers hold bytes.
- Scoped credentials: callers provide credential references or short-lived grants, not broad secrets.

## Core Resources

### Session

A session is a reusable workspace boundary. It can be backed by a Kubernetes Pod/PVC sandbox or another provider implementation.

Session states:

```text
queued -> provisioning -> ready -> busy -> ready
ready -> stopping -> stopped -> starting -> ready
ready|stopped -> archiving -> archived
any active state -> failed
stopped|archived|failed -> deleting -> deleted
```

### Job

A job is one unit of execution. It may run in a new ephemeral sandbox or inside a session.

Job states:

```text
queued -> preparing -> running -> succeeded
queued -> preparing -> running -> failed
queued -> preparing -> running -> timed_out
queued|preparing|running -> cancel_requested -> cancelled
```

### Artifact

Artifacts are immutable outputs copied out of the sandbox:

- `stdout`
- `stderr`
- `log`
- `file`
- `directory_archive`
- `patch`
- `test_report`
- `coverage`
- `screenshot`
- `metadata`

## API Surface

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/sessions` | Create a workspace session. |
| `GET` | `/v1/sessions/{sessionId}` | Inspect lifecycle, provider, resource, and workspace state. |
| `POST` | `/v1/sessions/{sessionId}/stop` | Stop an idle workspace and keep persistent state according to policy. |
| `POST` | `/v1/sessions/{sessionId}/archive` | Archive a stopped workspace and reduce active compute/storage footprint. |
| `DELETE` | `/v1/sessions/{sessionId}` | Delete workspace state according to retention policy. |
| `POST` | `/v1/jobs` | Submit an ephemeral job or a job bound to an existing session. |
| `GET` | `/v1/jobs/{jobId}` | Inspect final or current job state. |
| `POST` | `/v1/jobs/{jobId}/cancel` | Request cancellation. |
| `GET` | `/v1/jobs/{jobId}/events` | Stream lifecycle, logs, metrics, and artifact events over SSE. |
| `GET` | `/v1/jobs/{jobId}/artifacts` | List copied-out artifacts. |
| `GET` | `/v1/artifacts/{artifactId}/download` | Return a short-lived download redirect or signed URL. |

### Admin & Telemetry Surface

Admin endpoints require `admin:read` (for inspections) or `admin:operate` (for emergency controls).

| Method | Path | Scope | Purpose |
| --- | --- | --- | --- |
| `GET` | `/v1/admin/overview` | `admin:read` | Inspect aggregated system telemetry, jobs by state, active sessions, and database pool stats. |
| `GET` | `/v1/admin/jobs` | `admin:read` | List and filter jobs by state, tenantId, projectId, or sessionId with pagination. |
| `GET` | `/v1/admin/sessions` | `admin:read` | List and filter workspace sessions with pagination. |
| `GET` | `/v1/admin/audit-records` | `admin:read` | Query infrastructure authorization and access audit trail (`gateway_audit_records`). |
| `GET` | `/v1/admin/idempotency-keys` | `admin:read` | Inspect recorded idempotency keys and request hashes. |
| `POST` | `/v1/admin/jobs/{jobId}/cancel` | `admin:operate` | Emergency cancellation of a stuck or runaway job. |
| `POST` | `/v1/admin/sessions/{sessionId}/stop` | `admin:operate` | Emergency stop of a workspace session. |

## Request Shape

Minimal one-shot interpreter job:

```json
{
  "executionMode": "ephemeral_interpreter",
  "command": {
    "argv": ["python3", "-c", "print('hello')"],
    "cwd": "/workspace"
  },
  "inputs": {
    "files": [
      {
        "path": "input.json",
        "contentBase64": "eyJoZWxsbyI6ICJ3b3JsZCJ9"
      }
    ]
  },
  "timeoutSeconds": 120,
  "resources": {
    "cpu": 1,
    "memoryGiB": 1,
    "diskGiB": 3
  },
  "artifactPolicy": {
    "collect": ["stdout", "stderr", "logs", "workspace:/workspace/out"]
  }
}
```

Workspace job:

```json
{
  "executionMode": "workspace_session",
  "sessionId": "ses_01J...",
  "command": {
    "argv": ["bash", "-lc", "npm test"],
    "cwd": "/workspace/repo"
  },
  "timeoutSeconds": 900,
  "artifactPolicy": {
    "collect": ["stdout", "stderr", "workspace:/workspace/repo/test-results"]
  }
}
```

Optional custom sandbox configuration is additive and can be supplied on a
session or job. See [the custom image/bootstrap contract](sandbox-image-init-contract.md)
for the immutable image, profile, SecretRef, architecture, and init lifecycle
rules. Omitting `sandbox` keeps the default image and behavior.

## Event Stream

`GET /v1/jobs/{jobId}/events` uses `text/event-stream`.

Event types:

| Type | Meaning |
| --- | --- |
| `job.state` | Job lifecycle transition. |
| `session.state` | Session lifecycle transition relevant to the job. |
| `log.stdout` | Streamed stdout chunk. |
| `log.stderr` | Streamed stderr chunk. |
| `metric.sample` | Resource, duration, or provider sample. |
| `artifact.created` | Artifact has been copied out and is available. |
| `job.final` | Terminal summary. |
| `sandbox.init.*` | Bootstrap started, skipped, succeeded, or failed; payloads contain only an init hash/version and a generic failure category. |
| `heartbeat` | Keeps long streams alive. |

Every event includes a monotonic `sequence` so clients can resume with `Last-Event-ID`.

## Security Model

Authentication:

- Bearer token with service identity.
- Optional per-request actor context for audit attribution.

Authorization:

- Token scopes: `sessions:create`, `sessions:read`, `sessions:delete`, `jobs:create`, `jobs:read`, `jobs:cancel`, `artifacts:read`.
- Tenant/project scoping on every session, job, credential reference, and artifact.

Secrets:

- API callers pass `credentialRefs` or short-lived inline secrets.
- Inline secrets are write-only, redacted from read APIs, and never returned in events.
- Git credentials must be repository-scoped and branch/operation-scoped where possible.

Network:

- Default policy is outbound allowlist for package registries and Git remotes needed by the job.
- Inbound preview ports must be explicitly requested and time-limited.

## Audit Records

The gateway should record:

- caller identity and actor context
- idempotency key
- requested execution mode and provider selection
- sandbox/session/job lifecycle transitions
- credential refs used
- artifact manifest
- cancellation reason
- terminal status, exit code, timeout, and provider error category

## OpenAPI

The companion draft is in [agent-execution-gateway.v1.yaml](../openapi/agent-execution-gateway.v1.yaml).

## Idempotent Job Submission

`POST /v1/jobs` accepts an optional `Idempotency-Key` header. The key must be
8-200 characters using letters, digits, `.`, `_`, `~`, `:`, or `-`.

The gateway stores job idempotency records under the `jobs:create` route scope
and tenant/project boundary from the request. Request hashes use
`sha256:stable-json-v1`: object keys are sorted recursively, array order is
preserved, tenant/project scope is included, and secret-shaped fields such as
tokens, passwords, private keys, API keys, and inline secrets are redacted
before hashing. The service-auth metadata injected by the gateway is not part
of the caller request hash.

The stored response envelope contains the accepted HTTP status, public job
response body, resource type `job`, resource id, creation time, and expiry. The
default retention window is 24 hours. Replays with the same key and same
request hash return the stored accepted response; the same key with a different
request hash returns `409 Conflict`. The same external key can be reused in a
different tenant/project scope without conflict.

## Current HTTP Adapter

The first runnable adapter is `createAgentExecutionGatewayServer` in
`src/gateway/http-agent-execution-gateway.js`. It uses Node's built-in HTTP
server and wraps the in-memory gateway without adding a framework dependency.

Implemented behavior:

- `POST /v1/jobs` starts the gateway job in the background and returns `202`
  with the accepted job record.
- `GET /v1/jobs/{jobId}/events` returns `text/event-stream`, replays stored
  events after `Last-Event-ID`, and keeps the stream open while a job is active.
- `GET /v1/jobs/{jobId}/artifacts` returns artifact manifests without
  provider-local paths.
- `GET /v1/artifacts/{artifactId}/download` streams bytes from a configured
  ArtifactStore, with a local-provider fallback for development.
- Session create, inspect, and delete map directly to the provider-backed
  gateway session methods.
- Gateway-level job idempotency records are available through the configured
  `GatewayStore`; HTTP replay and conflict responses are implemented in the
  follow-up route behavior slice.

S3-compatible hosted artifact storage and presigned download URLs are
implemented through `S3ArtifactStore`. The HTTP route currently uses the
gateway-mediated download path. Direct signed-URL redirects, provider pools and
quotas, and cross-process provider cancellation remain deferred.

Service-token auth and tenant/project enforcement are documented in
[gateway-service-auth.md](gateway-service-auth.md).
