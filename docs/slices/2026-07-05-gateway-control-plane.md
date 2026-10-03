# Slice Handoff: Gateway Control Plane

Requirement: Design agent execution gateway control plane

Date: 2026-07-05

## Completed

- Drafted the external service API for sessions, jobs, events, cancellation, and artifacts.
- Defined lifecycle states for workspace sessions and sandbox jobs.
- Added security, idempotency, audit, artifact, and event-stream rules.
- Added an OpenAPI 3.1 draft for implementation handoff.

## Decisions

1. The first public API version is `/v1`.
2. `POST /v1/jobs` is the universal job submission endpoint.
3. `sessionId` binds a job to a workspace; omitting it allows an ephemeral interpreter job.
4. `GET /v1/jobs/{jobId}/events` is the single stream for lifecycle, logs, metrics, artifacts, and terminal summaries.
5. Artifact bytes are retrieved separately from the event stream.
6. Callers pass `credentialRefs` rather than broad credentials whenever possible.

## Files

- `docs/gateway-api.md`
- `openapi/agent-execution-gateway.v1.yaml`
