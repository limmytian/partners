# Sandbox MCP contract v1

Partners owns this contract. Pia integration is explicitly excluded per the user's scope correction; no external consumer is a delivery gate.

Protocol: **2025-11-25**, official SDK **1.31.0**, stateless Streamable HTTP `/mcp`, JSON responses. No MCP transport session IDs. Workspace session IDs are durable Gateway resources. GET and DELETE on the transport return 405; they do not delete workspaces. Unsupported protocol versions are rejected rather than silently negotiated. The seven tool input schemas and limits are executable in `src/mcp/contract.js`.

Compatibility evidence: local TW `packages/core/src/services/mcp-pool.ts` uses the SDK Client and StreamableHTTPClientTransport with configured auth headers; TW pnpm lock resolves its direct SDK dependency to 1.31.0. Contract tests negotiate and discover all seven tools with this same SDK. HTTP handshake/flow verification is part of the transport implementation test, not yet implied by this contract test. No Pia compatibility claim.

| Tool | Required scope | Side effect |
|---|---|---|
| session_create | sessions:create | create workspace; explicit authorized tenant/project |
| session_get | sessions:read | inspect |
| session_delete | sessions:delete | delete idle workspace |
| bash_exec | jobs:create | submit background job in authorized workspace |
| job_get | jobs:read | bounded log poll; artifact references additionally require artifacts:read |
| job_cancel | jobs:cancel | explicit cancellation |
| file_ops list/read | sessions:read | bounded workspace inspection |
| file_ops write | sessions:write | conditional atomic single-file write |

All resource IDs are resolved against trusted store records before authorization. Caller-supplied project/tenant IDs cannot alter resource ownership. Workspace privilege is tenant/project scoped; there is no user ACL promise. File operations do not expose sensitive-policy bypasses. `file_ops` has a mixed read/write annotation (never readOnly=true).

Creation/submission/writes require `requestId` (8–200 header-safe characters). Same logical operation retries use identical requestId and input. Expired keys are rejected rather than automatically reused. Different input under the same key conflicts. Pending or interrupted side effects are reported explicitly and never automatically replayed. Deduplication is scoped to tenant/project/tool/workspace for 24 hours; expired uncertain operations remain blocked for operator reconciliation.

`bash_exec` returns accepted jobId; job_get retains nonzero exit codes and distinguishes succeeded/failed/timed_out/cancelled. Disconnecting or cancelling an MCP RPC does not cancel an accepted sandbox job. `job_cancel` is explicit. File overwrite requires expectedHash or createOnly=true, exactly one; reads return a SHA-256 hash usable for conditional writes. Byte offsets are UTF-8 boundaries. Job cursors are opaque strings encoding event/byte offsets. Binary files are rejected. Directory cursors apply to the same path/depth listing and are not snapshots.

Errors use isError=true and structuredContent with code, traceId, retryable and known resource IDs. Authentication/Origin/oversize/version failures at transport ingress use HTTP errors; malformed JSON-RPC and unknown RPC methods remain SDK protocol errors. Unknown fields fail validation. Raw provider messages, file contents and shell commands must not be copied into audit/errors.

Production requires persistent coordination, scoped tokens, explicit enabled configuration and a validated sandbox provider. Local provider is trusted development execution on the host, not a production isolation boundary. Actual remote sandbox validation remains a separate delivery evidence item.

References: [MCP transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), [official SDK](https://ts.sdk.modelcontextprotocol.io/server).

Implementation details: see [MCP setup guide](sandbox-mcp.md), including the confirmed-runtime fence for CubeSandbox cancellation and limits on log capture, file hashing and directory enumeration.
