# Changelog

## 0.1.5 — release preparation

- Enforce tenant/project ownership for snapshots, templates, derived sessions, REST workspace jobs and scoped admin access.
- Reserve REST job submissions durably and atomically through the shared MCP coordinator; preserve replay across replicas and restarts.
- Persist snapshot/template metadata in PostgreSQL and require real PostgreSQL/MinIO CI without skipped tests.
- Correct CubeSandbox remote capability claims, resource IDs and unsupported snapshot/PTY paths.
- Negotiate MCP initialization versions through the official SDK for standard Agent clients.
- Upgrade the existing CubeSandbox cluster to official v0.8.0 with backup, restore and functional evidence.
- Retain sandbox destruction for confirmed remote cancellation; workspace-preserving process-tree cancellation remains unsupported.

See [release preparation](docs/release-v0.1.5.md) and [execution evidence](docs/iteration-v0.1.5-execution.md). This entry does not publish a stable tag or deploy Partners images.
