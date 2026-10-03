# Gateway Observability

Status: production metric contract baseline.

Reviewed on: 2026-07-05

## Principles

- Prometheus text exposition through `GET /metrics`.
- Bounded labels only: no tenant id, project id, job id, session id, artifact id,
  repository URL, command text, credential ref, or error message labels.
- Labels are limited to route, status class, execution mode, provider, terminal
  state, artifact backend, and artifact operation.
- Counters are monotonic within one gateway process. Gauges represent current
  process state or current Postgres pool state.

## HTTP Metrics

| Metric | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `partners_gateway_uptime_seconds` | gauge | none | Seconds since process metrics initialization. |
| `partners_gateway_http_requests_total` | counter | none | Total HTTP requests served by this process. |
| `partners_gateway_http_request_duration_ms_total` | counter | none | Accumulated HTTP request duration in milliseconds. |
| `partners_gateway_http_requests_by_status_total` | counter | `status_class` | Requests grouped into `2xx`, `4xx`, `5xx`, etc. |
| `partners_gateway_http_requests_by_route_total` | counter | `route` | Requests grouped by method and path. |

Route labels are literal method/path pairs from the HTTP adapter. They must stay
bounded to gateway routes; do not include query strings or request bodies.

## Job Metrics

| Metric | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `partners_gateway_jobs_started_total` | counter | `execution_mode`, `provider` | Accepted jobs that became visible in the gateway store. |
| `partners_gateway_jobs_terminal_total` | counter | `execution_mode`, `provider`, `state` | Jobs that reached `succeeded`, `failed`, `timed_out`, or `cancelled`. |
| `partners_gateway_jobs_running` | gauge | `execution_mode`, `provider` | Jobs accepted by this process and not yet terminal. |
| `partners_gateway_provider_runtime_duration_ms_count` | summary count | `execution_mode`, `provider`, `state` | Count of terminal provider runtimes observed by this process. |
| `partners_gateway_provider_runtime_duration_ms_sum` | summary sum | `execution_mode`, `provider`, `state` | Sum of provider runtime duration in milliseconds. |

Provider runtime is measured from accepted gateway job record creation to the
terminal result timestamp. It is intentionally process-local and does not try to
reconstruct already-running jobs after a restart.

Allowed terminal state labels are `succeeded`, `failed`, `timed_out`, and
`cancelled`. Unknown states are exported as `unknown`.

## Postgres Pool Metrics

| Metric | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `partners_gateway_postgres_pool_total` | gauge | none | Total clients in the configured `pg` pool. |
| `partners_gateway_postgres_pool_idle` | gauge | none | Idle clients in the configured `pg` pool. |
| `partners_gateway_postgres_pool_waiting` | gauge | none | Requests waiting for a pool client. |

These gauges are emitted when the configured store exposes `stats()`, which is
true for `PostgresGatewayStore` through `PgPoolPostgresRunner`. The metric names
are still present without samples for memory-store deployments.

## Artifact Failure Metrics

| Metric | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `partners_gateway_artifact_failures_total` | counter | `backend`, `operation` | Failed artifact store operations. |

`backend` is bounded to values such as `local` or `s3`. `operation` is one of
`write`, `read`, or `delete`. This metric increments only on thrown operation
failures; missing artifacts that return `null` or `false` are not counted as
backend failures.

## Alert Inputs

Alert rules and dashboard panel guidance are in
[gateway-observability-alerts.md](gateway-observability-alerts.md). They build
on these signals:

- sustained non-zero `partners_gateway_jobs_terminal_total{state="failed"}`
- sustained non-zero `partners_gateway_jobs_terminal_total{state="timed_out"}`
- `partners_gateway_jobs_running` stuck above normal concurrency for too long
- increasing `partners_gateway_artifact_failures_total`
- `partners_gateway_postgres_pool_waiting` greater than zero for a sustained
  window
- elevated `partners_gateway_http_requests_by_status_total{status_class="5xx"}`
