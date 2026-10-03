# In-Memory Agent Execution Gateway MVP

Status: historical behavioral baseline. Durable HTTP, Postgres, S3, service
authorization, idempotency, metrics, and audit follow-ups are now implemented.

Reviewed on: 2026-08-07.

This document describes the first runnable gateway core for Partners.

## Goal

Provide a provider-neutral orchestration layer above `AgentExecutionProvider` so callers can submit jobs, inspect status, replay events, list artifacts, cancel work, and manage sessions without depending on a specific provider SDK.

This MVP remains intentionally in-memory and dependency-free. It is the
behavioral reference used alongside the implemented durable HTTP/database
service.

## Implemented Surface

`InMemoryAgentExecutionGateway` currently supports:

- `createSession(request)`
- `getSession(sessionId)`
- `deleteSession(sessionId)`
- `runJob(request, onEvent)`
- `createJob(request, onEvent)` as an in-memory alias for `runJob`
- `getJob(jobId)`
- `listJobEvents(jobId, { afterSequence })`
- `listJobArtifacts(jobId)`
- `cancel(jobId, reason)`

`createAgentExecutionGatewayServer` exposes the same in-memory gateway over a
dependency-free Node HTTP adapter:

- `GET /health`
- `POST /v1/sessions`
- `GET /v1/sessions/{sessionId}`
- `DELETE /v1/sessions/{sessionId}`
- `POST /v1/jobs`
- `GET /v1/jobs/{jobId}`
- `POST /v1/jobs/{jobId}/cancel`
- `GET /v1/jobs/{jobId}/events`
- `GET /v1/jobs/{jobId}/artifacts`
- `GET /v1/artifacts/{artifactId}/download`

## Responsibilities

| Area | MVP behavior |
| --- | --- |
| Provider boundary | Wraps any provider implementing `runJob`; session methods are enabled when the provider supports them. |
| Job ownership | Assigns job IDs when absent, stores queued/running/final state, timeout, exit code, provider, timestamps, and metadata. |
| Store boundary | Uses `GatewayStore` for sessions, jobs, events, artifacts, cancellation markers, and idempotency records. |
| Service auth | Optionally enforces bearer service tokens, route scopes, expiry, and tenant/project bounds. |
| HTTP job submission | Starts `createJob` in the background and returns the accepted job record immediately. |
| Event stream | Stores gateway-sequenced events and supports SSE replay after `Last-Event-ID`. |
| Artifacts | Indexes artifacts announced by events or returned in final job results. |
| Artifact download | Streams local artifact bytes by artifact ID without exposing sandbox-local paths in list responses. |
| Cancellation | Records `cancel_requested`, calls provider cancellation when available, and leaves terminal status to the provider result. |
| Failure handling | Converts provider exceptions into failed job results with a final event. |

## Relationship to OpenAPI

The class mirrors the resource behavior in
`openapi/agent-execution-gateway.v1.yaml`. The implemented HTTP adapter maps:

- `POST /v1/sessions` to `createSession`
- `GET /v1/sessions/{id}` to `getSession`
- `DELETE /v1/sessions/{id}` to `deleteSession`
- `POST /v1/jobs` to `createJob` or an async durable queue
- `GET /v1/jobs/{id}` to `getJob`
- `GET /v1/jobs/{id}/events` to `listJobEvents` or SSE over the same event records
- `GET /v1/jobs/{id}/artifacts` to `listJobArtifacts`
- `POST /v1/jobs/{id}/cancel` to `cancel`

## Relationship to Task Weaver

The Task Weaver bridge can use this gateway directly in tests and local
integration. The production-shaped service uses the durable HTTP, GatewayStore,
and ArtifactStore boundaries while keeping the same request, event, artifact,
and result semantics.

## Follow-Up Status

Implemented after this MVP:

- durable Postgres persistence for sessions, jobs, events, artifacts,
  cancellation markers, idempotency keys, service tokens, and audit records;
  see [gateway-store.md](gateway-store.md)
- S3-compatible artifact bytes and presigned downloads; see
  [s3-artifact-store.md](s3-artifact-store.md)
- service-token authorization and tenant/project enforcement; see
  [gateway-service-auth.md](gateway-service-auth.md)
- HTTP/SSE transport and Prometheus metrics; see
  [gateway-api.md](gateway-api.md) and
  [gateway-observability.md](gateway-observability.md)

Still open: provider pool selection and quotas, generalized automatic retry
policy, and cancellation of provider work owned by another gateway process.
