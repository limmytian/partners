# Partners Sandbox MCP

Partners exposes **seven tools** at `/mcp` using stateless Streamable HTTP and protocol **2025-11-25**. The official SDK is pinned to **1.31.0**. It uses JSON responses, no transport session IDs, and no legacy HTTP+SSE endpoint. Workspace sessions survive disconnects. Unsupported protocol versions fail explicitly.

## Enable

MCP is disabled by default. Production requires `GATEWAY_STORE=postgres`, a configured scoped service token, and a remote sandbox provider. Host execution or CubeSandbox simulation requires the explicit development flag `GATEWAY_MCP_ALLOW_LOCAL=1`, even with PostgreSQL. Local execution is trusted host execution, not sandbox isolation.

Set these through your existing secret/config deployment mechanism:

```text
GATEWAY_MCP_ENABLED=1
GATEWAY_STORE=postgres
GATEWAY_PROVIDER=kubernetes
GATEWAY_MCP_ALLOWED_ORIGINS=https://your-agent.example
GATEWAY_MCP_ALLOWED_PROFILES=python-tools
GATEWAY_SERVICE_SCOPES=sessions:create,sessions:read,sessions:write,sessions:delete,jobs:create,jobs:read,jobs:cancel,artifacts:read
GATEWAY_TENANT_IDS=<tenant-id>
GATEWAY_PROJECT_IDS=<project-id>
```

Configure `POSTGRES_URL`, `GATEWAY_SERVICE_TOKEN`, and the provider's existing settings separately. Keep tokens out of URLs, tool arguments, Git and documents. A service-to-service client without an Origin header is accepted after authentication. Browser clients must use the exact origin allowlist. OAuth user flows are not implemented.

For CubeSandbox use `GATEWAY_PROVIDER=cubesandbox`, `CUBESANDBOX_ENDPOINT`, `CUBESANDBOX_PROXY_ENDPOINT` and its API credential. Production file operations require Python 3 supporting isolated mode `-I`, POSIX dir_fd/no-follow operations, and `/workspace` in the sandbox. The bundled Kubernetes sandbox image supplies Python. An incompatible image fails explicitly; missing capability or runtime uncertainty is reported instead of falling back to host execution.

`/ready` reports enabled/protocol/persistent coordination and existing provider readiness. `/metrics` adds bounded per-tool call and duration counters; audit records include identity, scope decisions, tool, resource and outcome, without command/file bodies or bearer values.

## Client flow

```js
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const client = new Client({ name: 'your-agent', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(process.env.MCP_URL), {
  requestInit: { headers: { Authorization: `Bearer ${process.env.MCP_TOKEN}` } }
}));
const tools = await client.listTools();
```

1. `session_create`: authorized `tenantId`, `projectId`, unique `requestId`, optional allowed `profile` and idle `ttlSeconds`. Returns `sessionId`, limits and capabilities.
2. `file_ops`: `action=write`, relative `path`, UTF-8 `content`, `requestId`, and either `createOnly=true` or `expectedHash`. New parent directories are created safely for create-only writes. Overwrite requires the hash obtained from a read.
3. `bash_exec`: `sessionId`, command, unique `requestId`, optional relative `cwd` and `timeoutSeconds`. Runs bash -lc in the selected runtime and returns an accepted `jobId` promptly.
4. `job_get`: `jobId`, optional opaque `cursor` and `maxOutputBytes`. Poll for terminal state; retain nonzero exit codes. Cursor encodes event and byte offset, preventing dropped output inside a large event. Concatenate pages; `truncated` indicates unread pages; `outputTruncated` separately indicates the overall capture limit. Available artifact references use existing authenticated download routes.
5. `file_ops`: `action=read` supports UTF-8 byte offsets and `maxBytes`; list supports path/depth/cursor/limit. Reads return SHA-256 for conditional writes. Sensitive files, binary previews, traversal and symlinks are rejected. Directory cursor pages are not snapshots.
6. `job_cancel`: explicitly cancel a job. Closing the MCP connection does not cancel accepted jobs.
7. `session_get` / `session_delete`: inspect or delete the idle workspace. Deletion requires sessions:delete. Busy workspaces must be cancelled first.

MCP-created workspaces are exclusively mutated through MCP tools, ensuring all writers share persistent coordination. Legacy REST reads and artifact downloads remain available. REST job submission, file sync, deletion and PTY creation on these workspaces return 409; this does not affect ordinary REST-created workspaces. MCP-created job cancellation through REST still writes the same persistent cancellation intent. Use job_get for MCP progress; the legacy live SSE feed is not an MCP subscription API.

**CubeSandbox cancellation/timeout destroys the affected workspace to confirm execution stopped.** This is a conservative fence until a process-kill capability is validated. The Gateway marks it deleted; create a new workspace for further work. Local cancellation kills the process group and keeps the workspace; Kubernetes uses its sandbox-agent cancellation interface. Artifacts are retained independently when already published.

## Limits and recovery

Defaults: command timeout 120s (max 900s); workspace idle TTL 30m and absolute lifetime 8h; one writer per workspace; MCP admission limits of 10 live sessions and 20 active jobs per tenant (existing Gateway resources count toward admission). Absolute expiry requests cancellation and after a 30s grace period fences the workspace. The reaper runs every 5s. Busy read helpers serialize with execution to avoid overlapping remote exec requests.

Requests are limited to 1MiB, single writes to 256KiB, previews/output pages to 64KiB (default 16KiB, min 4 bytes for UTF-8). File hashing accepts regular files up to 64MiB. Directory enumeration is bounded at 10,000 inspected entries, page size max 500, depth max 5. Logs are capped at 16MiB per job/remote response; reaching a capture limit is not a claim of complete output. Legacy artifact paths remain subject to retention. Command arguments are capped at 64KiB to avoid OS argument-size limits.

Use the same requestId and unchanged normalized arguments when retrying a logical creation/submission/write. Do not use JSON-RPC IDs for deduplication. Same key with different input gives IDEMPOTENCY_CONFLICT. Busy/quota admission failures happen before execution; an identical later retry can proceed when capacity becomes available. Operations remain recorded; after 24h reusing an old key gives IDEMPOTENCY_EXPIRED. The implementation does not automatically purge uncertain operations or reuse their keys.

Pending accepted jobs/sessions can be located by their persisted resource ID without rerunning the provider. Uncertain writes remain OPERATION_PENDING and require inspection. Resource lease heartbeats run every 2s; after 45s without evidence a running job becomes EXECUTION_UNKNOWN and the workspace is quarantined. A late worker cannot overwrite this recovery verdict. Delete the quarantined workspace to fence it before starting new work. An uncertain tenant-wide provisioning lock remains fail-closed for operator reconciliation; it is never automatically stolen to repeat sandbox creation. Coordination rows intentionally preserve recovery evidence and require an operator retention policy.

A privileged operator reconciling a stuck request/tenant lock must inspect `gateway_mcp_operations` and the provider, confirm/fence any possibly created runtime, and only then release the recorded lock. This is not exposed as an LLM bypass tool.

## Smoke test and rollback

Use an environment-issued token with the scopes above:

```sh
MCP_URL=https://your-gateway.example/mcp \
MCP_TENANT_ID=<tenant-id> MCP_PROJECT_ID=<project-id> \
  npm run mcp:smoke
```

Supply `MCP_TOKEN` through the environment/secret manager. The smoke script discovers tools, creates its own workspace, writes a Python file, executes it, polls output, reads/lists files and deletes the workspace. It never modifies an existing workspace.

Rollback: stop new clients, cancel/drain owned jobs and delete test/workspace sessions through MCP; then set `GATEWAY_MCP_ENABLED=0` and restart/redeploy the gateway. Schema additions are additive; do not drop recovery records or existing Gateway tables. Existing REST-created workspaces and APIs remain compatible. Rollout/remote sandbox acceptance must be validated in your environment before production use.

## Real runtime validation

`npm run mcp:validate-live` exercises the actual Gateway entrypoint against remote CubeSandbox and an isolated PostgreSQL test database. Set `CUBESANDBOX_ENDPOINT`, `CUBESANDBOX_PROXY_ENDPOINT`, and `MCP_TEST_POSTGRES_URL`; optionally supply `CUBESANDBOX_API_KEY`. It creates real VMs, kills/restarts its Gateway process, waits for actual lease/TTL expiry, and deletes only its own VMs. It writes JSON evidence and durable artifacts to a temporary directory. See [validation results](sandbox-mcp-validation.md). Remote stdout/stderr stream incrementally with UTF-8 boundaries preserved and are retained as separate artifacts.
