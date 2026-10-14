# Partners v0.1.4 deployment — 2026-10-14

PR #1 merged into main at `e47689716ac16f8bdccaeba7d7d6d12533a368a4`. Published release [v0.1.4](https://github.com/limmytian/partners/releases/tag/v0.1.4) built and pushed Gateway, Sandbox and Console images for linux/amd64 and linux/arm64. [Build](https://github.com/limmytian/partners/actions/runs/38550418826) succeeded. [Main CI](https://github.com/limmytian/partners/actions/runs/38550385991) passed on Node 20/22 after rerunning an HTTP cancellation test that exceeded its short polling window on the first attempt.

Deployed to context `default`, namespace `partners`, using immutable v0.1.4 image digests. Gateway and Console completed rolling updates and are ready with zero restarts, on `dell-r730`. The unused Kubernetes sandbox-agent image reference was updated to the same release pair; active execution continues through CubeSandbox and its existing template.

The live environment differs from the generic Kubernetes-provider release manifest. Server-side dry-run and targeted ConfigMap/Deployment patches preserved its CubeSandbox, PostgreSQL, S3, RBAC and Secret configuration. Old code-override mounts were removed so the actual image supplies the code; `GATEWAY_MCP_ENABLED=1` was added. No Secret values were changed. Pre-deployment configuration and deployment snapshots were saved locally under `/tmp/partners-v014-*-before.json` for rollback; these contain no decoded Secret values.

Verified actual container package version 0.1.4 and pinned running image IDs. Health, readiness, metrics and unauthenticated MCP rejection passed. Standard SDK discovered all seven tools and verified conditional file write/read, idempotent replay, execution with Chinese output, S3 stdout/stderr artifacts and authorized downloads, confirmed remote cancellation and timeout. REST execution and SSE replay passed. Validation created and deleted only its own temporary sandboxes.

Exact digests, pods and job IDs are in [the deployment evidence](release-v0.1.4-deployment.json). Gateway is internally available at `http://partners-gateway.partners.svc:8080/mcp`; external access uses the existing network/access configuration and the service token supplied through the external Secret.

Rollback restores the saved ConfigMap data and Gateway/Console pod templates, then checks readiness and health. Restoring the Gateway template also restores its prior code-override mounts. A deployment rollback does not undo PostgreSQL schema additions or rotate credentials.
