# Gateway Alerts and Dashboard Guidance

Status: production observability guidance baseline.

Reviewed on: 2026-07-05

## Scrape Configuration

Scrape `GET /metrics` from every gateway pod or process. A Kubernetes
Prometheus scrape target should use the `partners-gateway` service on port
`8080` and path `/metrics`.

Example static scrape job:

```yaml
scrape_configs:
  - job_name: partners-gateway
    metrics_path: /metrics
    static_configs:
      - targets:
          - partners-gateway.partners.svc.cluster.local:8080
```

Use external labels such as cluster, namespace, and environment from Prometheus
configuration. Do not add tenant, project, job, artifact, repository, or command
labels at scrape time.

## Prometheus Alert Rules

```yaml
groups:
  - name: partners-gateway
    rules:
      - alert: PartnersGatewayHigh5xxRate
        expr: increase(partners_gateway_http_requests_by_status_total{status_class="5xx"}[5m]) > 5
        for: 10m
        labels:
          severity: page
        annotations:
          summary: Partners gateway is returning elevated 5xx responses
          description: More than five 5xx responses were observed over five minutes.

      - alert: PartnersGatewayJobFailures
        expr: increase(partners_gateway_jobs_terminal_total{state="failed"}[10m]) > 3
        for: 10m
        labels:
          severity: ticket
        annotations:
          summary: Partners gateway job failures increased
          description: Failed terminal jobs exceeded the operational threshold.

      - alert: PartnersGatewayJobTimeouts
        expr: increase(partners_gateway_jobs_terminal_total{state="timed_out"}[15m]) > 2
        for: 15m
        labels:
          severity: ticket
        annotations:
          summary: Partners gateway job timeouts increased
          description: Timed-out terminal jobs may indicate provider saturation or bad timeout defaults.

      - alert: PartnersGatewayRunningJobsStuck
        expr: partners_gateway_jobs_running > 0
        for: 45m
        labels:
          severity: ticket
        annotations:
          summary: Partners gateway has long-running active jobs
          description: Running jobs have remained active longer than the expected execution window.

      - alert: PartnersGatewayArtifactFailures
        expr: increase(partners_gateway_artifact_failures_total[10m]) > 0
        for: 5m
        labels:
          severity: page
        annotations:
          summary: Partners gateway artifact backend failures
          description: Artifact write, read, or delete operations are failing.

      - alert: PartnersGatewayPostgresPoolWaiting
        expr: partners_gateway_postgres_pool_waiting > 0
        for: 10m
        labels:
          severity: ticket
        annotations:
          summary: Partners gateway Postgres pool has waiting clients
          description: Requests are waiting for a Postgres pool client; inspect pool sizing and database latency.
```

Tune thresholds per environment after collecting a baseline. Page only for
signals that affect request acceptance, artifact durability, or sustained 5xx
rates.

## Grafana Dashboard Layout

Recommended rows:

| Row | Panels |
| --- | --- |
| Overview | Uptime, request rate, 5xx rate, active jobs, failed jobs, artifact failures. |
| HTTP | Requests by route, requests by status class, request duration total rate. |
| Jobs | Started jobs by execution mode/provider, terminal jobs by state, running jobs by provider. |
| Provider Runtime | Runtime average from `rate(sum[5m]) / rate(count[5m])`, grouped by provider and terminal state. |
| Storage | Artifact failures by backend/operation, Postgres pool total/idle/waiting. |
| Release Smoke | Last smoke result annotation, restart durability check status, deploy image tag annotation. |

Suggested PromQL snippets:

```promql
sum by (status_class) (rate(partners_gateway_http_requests_by_status_total[5m]))
sum by (execution_mode, provider) (partners_gateway_jobs_running)
sum by (state) (rate(partners_gateway_jobs_terminal_total[5m]))
sum by (backend, operation) (increase(partners_gateway_artifact_failures_total[15m]))
partners_gateway_postgres_pool_waiting
sum by (provider, state) (rate(partners_gateway_provider_runtime_duration_ms_sum[5m]))
/
sum by (provider, state) (rate(partners_gateway_provider_runtime_duration_ms_count[5m]))
```

## Triage Links

- Metrics contract: [gateway-observability.md](gateway-observability.md)
- Operations runbook: [gateway-operations.md](gateway-operations.md)
- Release validation handoff:
  [2026-07-05-release-validation-handoff.md](slices/2026-07-05-release-validation-handoff.md)
