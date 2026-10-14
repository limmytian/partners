# Partners v0.1.4

Partners Gateway now exposes an authenticated Sandbox MCP Server at `/mcp`, with seven tools for workspace lifecycle, asynchronous shell execution, job polling/cancellation, and sandbox-side file operations. MCP ships inside the Gateway process and image.

The release adds persistent PostgreSQL coordination, request replay/conflict detection, scope checks, single-writer admission, bounded UTF-8 output, durable stdout/stderr artifacts, TTL cleanup, and fail-closed recovery after worker loss. Remote CubeSandbox output is streamed incrementally; timeout/cancellation wait for confirmed runtime destruction. Cube cancellation destroys the workspace.

MCP is disabled by default. Enable `GATEWAY_MCP_ENABLED=1` with the authentication, database, provider and limits described in [the setup guide](sandbox-mcp.md). Existing REST endpoints remain available; conflicting mutations of MCP-managed workspaces are rejected.

Validation: 147 automated tests, 146 passed, 0 failed, one conditional MinIO test skipped. Real Dell CubeSandbox acceptance passed file/exec/replay, Unicode pagination, artifact download, cancel/timeout, Gateway restart, killed-worker recovery and idle TTL reclamation. See [the evidence](sandbox-mcp-validation.md).

Release preparation does not attest a production image build or rollout. Packaging publishes paired Gateway/sandbox images; deployment uses their immutable digests through [the existing release flow](gateway-release.md).

Deployment completed on 2026-10-14; see [the deployment record](release-v0.1.4-deployment.md).
