# Sandbox MCP validation — 2026-10-14

Implementation branch: `codex/sandbox-mcp`. Requirement: `0b1b70d7-4eb1-4a08-8b97-1a6c43206499`.

Final full-suite result with a fresh configured PostgreSQL database: **147 tests, 146 passed, 0 failed, 1 MinIO environment test skipped**. The standalone `mcp:smoke` script also passed against the actual local service entrypoint.

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

## Live CubeSandbox acceptance — passed

Dell node `dell-r730` became Ready and cube-api/cube-proxy recovered. On 2026-10-14 09:06:46–09:07:48 UTC, the standard SDK drove the actual Gateway service entrypoint with PostgreSQL and real MicroVMs on Dell. Gateway ran locally through Kubernetes port forwards; this verifies the remote runtime integration, not a production Gateway rollout.

- Create/replay, sandbox-side conditional file writes/read/list, reconnect, request conflicts and sensitive-file/symlink boundaries passed.
- Exactly 60,001 UTF-8 output bytes survived paginated reads. Nonzero exit and authenticated durable stdout/stderr artifact downloads passed.
- Cancellation and one-second timeout confirmed actual VM destruction before reporting their respective terminal states.
- Gateway restart preserved completed jobs, workspace contents and idempotent replay. SIGKILL during a running command, restart and actual lease expiry produced EXECUTION_UNKNOWN; further execution was blocked until explicit runtime fencing.
- Actual 60-second idle TTL reclaimed the VM. All five VMs created by the run were removed; existing sandboxes were preserved.

Live testing found and fixed incremental envd frame decoding (independent UTF-8 stdout/stderr decoders), missing stderr artifacts and the race between exec connection closure and deletion acknowledgment. Regression tests cover these failures.

Evidence run: `46f9622b-7bea-41d5-9987-78ac453b85cf`; guest kernel `6.6.1199-0009-03_2.0.1`, working directory `/workspace`. Template `tpl-24b408a967a14772b6acf309`, image SHA-256 `467494c38f3c335e42d590e23d5cbb00dc15c2627c9da4f7e7f3bd9f4ec18c5e`.

Machine-readable evidence is retained in [the committed run record](sandbox-mcp-live-evidence.json). The reusable harness generates its own evidence and artifacts directory, uses a unique test tenant, and cleans up only its own VMs:

```sh
CUBESANDBOX_ENDPOINT=<reachable-api-url> \
CUBESANDBOX_PROXY_ENDPOINT=<reachable-proxy-url> \
MCP_TEST_POSTGRES_URL=<isolated-test-postgres-url> npm run mcp:validate-live
```

Production image build/rollout was not performed. The six implementation/acceptance tasks are complete; the requirement remains in review for code review. Cube cancellation intentionally destroys its workspace; preserve needed files as durable artifacts beforehand.

Remaining operational boundaries are documented in [the setup guide](sandbox-mcp.md): trusted Local development, Python/runtime prerequisites, capped log capture, and fail-closed operator reconciliation of uncertain provisioning/write operations. No external agent product is a delivery prerequisite.
