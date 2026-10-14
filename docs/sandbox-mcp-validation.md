# Sandbox MCP validation — 2026-10-14

Implementation branch: `codex/sandbox-mcp`. Requirement: `0b1b70d7-4eb1-4a08-8b97-1a6c43206499`.

Final full-suite result with a fresh configured PostgreSQL database: **144 tests, 143 passed, 0 failed, 1 MinIO environment test skipped**. The standalone `mcp:smoke` script also passed against the actual local service entrypoint.

## Verified

- MCP 2025-11-25 with pinned official SDK 1.31.0: HTTP initialize, ping, tool discovery, seven contracts, call results/errors, reconnection and background job polling.
- Local HTTP end-to-end workspace → conditional Python file write → execution → paged Unicode output → file read/list → delete.
- Authentication, tenant/project/scope rejection, forbidden Origin, oversized requests and unsupported version rejection. MCP host execution/simulation and memory coordination require an explicit development flag.
- Persistent PostgreSQL: 40 competing reservations over independent connections produce one winner; 20 submissions through two Gateways start one actual provider job. A newly constructed service replays the accepted job. This test shares a Local runtime backend to measure Gateway/store coordination, not independent remote sandbox processes.
- Concurrent schema initialization exposed a PostgreSQL DDL race; migration now uses transaction-scoped advisory locks. The full suite was rerun on a new UTF-8 database.
- Unknown failures retain request reservations. Lost job ownership is diagnosed after the heartbeat window, quarantines the workspace and preserves the unknown verdict against late worker writes. Cancellation intent is persisted and checked before execution and by the owning worker.
- File policy executes inside the selected runtime with isolated Python (`-I`), dir_fd and no-follow operations. Local tests cover sensitive files, symlinks, binary previews, conditional conflicts, create-only competition, UTF-8 byte offsets, directory paging, OS argument-size limits and malicious workspace Python modules.
- Job timeout/cancellation, process-group termination including TERM-resistant descendants, single writer, idle TTL, retained job records and startup readiness.
- CubeSandbox adapter contract fixtures cover provider-assigned IDs, fixed sandbox-side file helper and confirmed runtime deletion on cancellation. These are adapter tests, not live MicroVM evidence.
- Cube command/provisioning fallback is allowed only for an unsupported endpoint, avoiding duplicate work after ambiguous network errors. Missing exit confirmation is treated as an execution error.

Run local and configured PostgreSQL validation:

```sh
npm test
MCP_TEST_POSTGRES_URL=<isolated-test-postgres-url> \
POSTGRES_URL=<isolated-test-postgres-url> npm test
```

The Postgres test URL must name a disposable test database, not production. The independently named MCP variable enables its multi-replica tests; POSTGRES_URL also enables the existing Gateway persistence test. MinIO validation remains conditional on its existing environment settings.

## Pending real environment evidence

The current Kubernetes API can list CubeSandbox workloads, but the service health request returns `ServiceUnavailable: no endpoints available for service "cube-api"`. Both cube-api and cube-proxy port-forward attempts fail with a kubelet backend `502 Bad Gateway`. No sandbox was created and no cluster configuration was changed.

Consequently live CubeSandbox create/exec/files/cancel/timeout/restart acceptance and production image/deployment verification are not complete. The release/acceptance task stays in review; the requirement is not marked done or ready to merge. After the service is healthy, run `npm run mcp:smoke` with a scoped test token, then validate remote cancellation, timeout and cross-process restart/fencing. Cube cancellation intentionally destroys its workspace, unlike Local; preserve needed files as durable artifacts beforehand.

Remaining operational boundaries are documented in [the setup guide](sandbox-mcp.md): trusted Local development, Python/runtime prerequisites, capped log capture, and fail-closed operator reconciliation of uncertain provisioning/write operations. No external agent product is a delivery prerequisite.
