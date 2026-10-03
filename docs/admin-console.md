# Partners Admin Console

The Partners Admin Console is an independent, lightweight web application for infrastructure operators and SREs to monitor, inspect, and audit Partners agent execution gateway runtime.

## Key Capabilities

1. **Infrastructure Health & Telemetry**:
   - Gateway uptime and active execution counts.
   - Breakdown of jobs by state (`running`, `queued`, `preparing`, `succeeded`, `failed`, `timed_out`, `cancelled`).
   - Active workspace sessions and resource persistence.
   - PostgreSQL connection pool health (`total`, `idle`, `waiting`).

2. **Infrastructure-Level Audit Trail**:
   - Live query of `gateway_audit_records`.
   - Filter by actor, scope, token reference, outcome (`accepted` / `denied`), and timestamp.
   - Inspect authorization rejections and scope mismatch attempts.

3. **Jobs & Sessions Explorer**:
   - Inspect active and completed jobs, exit codes, execution modes, and tenant scopes.
   - Real-time SSE streaming for live container `stdout` and `stderr` logs (no `kubectl` needed).
   - Inspect workspace sessions and persistent storage attachment.

4. **Emergency Controls**:
   - Emergency cancellation of stuck or runaway jobs (`POST /v1/admin/jobs/{jobId}/cancel`).
   - Graceful stop of idle or lingering workspace sessions (`POST /v1/admin/sessions/{sessionId}/stop`).

5. **Idempotency Diagnostics**:
   - Inspect recorded idempotency keys, request hashes, and expiration timestamps to diagnose `409 Conflict` issues.

---

## Architecture & Security

```
┌────────────────────────────────────────────────────────┐
│             Partners Admin Console (Web)               │
└───────────┬────────────────────────────────┬───────────┘
            │ Direct CORS or /api/proxy      │
            ▼                                ▼
┌────────────────────────┐      ┌────────────────────────┐
│ partners-gateway API   │      │ PostgreSQL Store       │
│ - Scoped Service Token │      │ - gateway_audit_records│
│ - admin:read / operate │      │ - gateway_idempotency  │
│ - SSE /v1/jobs/:id/ev  │      │ - gateway_service_token│
└────────────────────────┘      └────────────────────────┘
```

- **Scope Enforcement**:
  - `admin:read` (or `*`): required for telemetry, job lists, session lists, audit queries, and idempotency inspection.
  - `admin:operate` (or `*`): required for emergency job cancellation and session stopping.
- **Network Isolation**:
  - The Admin Console can be deployed strictly within internal VPC / bastion networks.
  - The Gateway supports CORS for trusted origins and preflight `OPTIONS` requests.

---

## Local Development

Start the Console locally:

```bash
# Connects to default http://localhost:8080
npm run console:service
```

Or configure custom target gateway and port:

```bash
CONSOLE_PORT=3000 PARTNERS_GATEWAY_URL=http://localhost:8080 npm run console:service
```

Open `http://localhost:3000` in your browser.

---

## Docker & Compose Deployment

The Console is built into `docker-compose.gateway-smoke.yml`:

```bash
docker compose -f docker-compose.gateway-smoke.yml up -d --build
# Access console on http://localhost:13000
```

---

## Kubernetes Deployment

Deploy Console alongside Gateway in the `partners` namespace using the dedicated release script:

```bash
# 1. Quick local / tag-based deployment:
DEPLOY_MODE=local K8S_CONTEXT=<context> bash scripts/console-release.sh deploy

# 2. Production deployment with immutable image digest:
K8S_CONTEXT=<context> \
CONSOLE_IMAGE_DIGEST=sha256:<64 hex characters> \
bash scripts/console-release.sh deploy

# 3. Rollback if needed:
K8S_CONTEXT=<context> bash scripts/console-release.sh rollback

# 4. Smoke test & port-forward health check:
K8S_CONTEXT=<context> bash scripts/console-release.sh smoke
```

Or apply the manifest directly:

```bash
kubectl apply -f k8s/k8s-partners-console.yaml
```

To expose externally, attach an Ingress or set Service `type: NodePort` according to cluster policies.
