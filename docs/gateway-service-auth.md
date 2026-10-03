# Gateway Service Auth

Status: optional HTTP authorizer with durable token-store and operator lifecycle support.

Reviewed on: 2026-07-05

## Goal

Allow trusted services such as Task Weaver to call the Partners gateway with a
scoped service token. The gateway must reject requests before provider work
starts when the token is missing, expired, lacks the required route scope, or is
outside the requested tenant/project boundary.

## Authorizer

`GatewayServiceAuthorizer` accepts an in-memory token registry:

```js
new GatewayServiceAuthorizer({
  tokens: [{
    token: 'raw service token, loaded from secret storage',
    // or tokenHash: 'sha256 hex'
    tokenRef: 'tok_task_weaver_prod',
    actor: 'task-weaver',
    scopes: ['jobs:create', 'jobs:read'],
    tenantIds: ['tenant_1'],
    projectIds: ['project_1'],
    expiresAt: '2026-07-06T00:00:00.000Z',
  }],
})
```

If no tokens are configured, auth is disabled for local tests and development.
When tokens are configured, every protected route requires
`Authorization: Bearer <token>`.

For production-like local runs, `GatewayServiceAuthorizer` can also read
service-token metadata from `PostgresGatewayStore`. The store persists only
SHA-256 token hashes, token refs, actor, scopes, tenant/project bounds, expiry,
revocation, and metadata. `scripts/gateway-service.mjs` bootstraps
`GATEWAY_SERVICE_TOKEN` into Postgres when `GATEWAY_STORE=postgres`.

The authorizer stores SHA-256 hashes internally and compares them with
`timingSafeEqual`. Error payloads never include raw bearer values or registered
token secrets.

## Token Operations

Use the operator CLI with `POSTGRES_URL` pointed at the gateway database:

```bash
POSTGRES_URL=postgres://partners:partners@postgres:5432/partners \
  npm run gateway:token -- create \
  --ref tok_task_weaver_prod_202607 \
  --actor task-weaver \
  --scope jobs:create,jobs:read,artifacts:read \
  --tenant tenant_1 \
  --project project_1 \
  --expires-at 2026-10-01T00:00:00.000Z
```

`create` and `rotate` print `tokenValue` once. Store it immediately in the
deployment secret manager. The gateway database stores only the SHA-256 hash and
metadata.

Supported commands:

| Command | Purpose |
| --- | --- |
| `create` | Create a new hashed service token and print the raw value once. |
| `list` | List public token metadata; token hashes are redacted. |
| `show` | Show one token by `tokenRef` without hash or raw value. |
| `update` | Change actor, scopes, tenant/project bounds, expiry, or metadata without changing the secret. |
| `rotate` | Create a replacement token, optionally `--revoke-old` after clients move. |
| `revoke` | Set `revokedAt` and add operation metadata. |
| `audit` | List token-related audit rows by token ref. |

Rotation with overlap:

```bash
npm run gateway:token -- rotate \
  --ref tok_task_weaver_prod_202607 \
  --new-ref tok_task_weaver_prod_202610 \
  --expires-at 2027-01-01T00:00:00.000Z
```

After clients use the new secret:

```bash
npm run gateway:token -- revoke \
  --ref tok_task_weaver_prod_202607 \
  --reason "rotated to tok_task_weaver_prod_202610"
```

For emergency rotation, use `rotate --revoke-old` and redeploy clients with the
new one-time `tokenValue`.

## Route Scopes

| Route | Required scope |
| --- | --- |
| `POST /v1/sessions` | `sessions:create` |
| `GET /v1/sessions/{sessionId}` | `sessions:read` |
| `DELETE /v1/sessions/{sessionId}` | `sessions:delete` |
| `POST /v1/jobs` | `jobs:create` |
| `GET /v1/jobs/{jobId}` | `jobs:read` |
| `GET /v1/jobs/{jobId}/events` | `jobs:read` |
| `POST /v1/jobs/{jobId}/cancel` | `jobs:cancel` |
| `GET /v1/jobs/{jobId}/artifacts` | `artifacts:read` |
| `GET /v1/artifacts/{artifactId}/download` | `artifacts:read` |

`*` grants all scopes and should be reserved for local smoke tests or tightly
controlled service accounts.

## Tenant and Project Scope

Create requests are checked against `tenantId` and `projectId` in the request
body. Read, cancel, artifact, and download requests are checked against the
stored job/session resource scope. A token may be:

- global for a scope when `tenantIds` and `projectIds` are empty
- tenant-limited with one or more `tenantIds`
- project-limited with one or more `projectIds`

The gateway records accepted `tenantId`, `projectId`, and `actor` fields on job
and session records so later read/cancel/artifact operations can enforce the
same boundary.

## Audit Metadata and Redaction

Accepted create requests add:

```json
{
  "metadata": {
    "gatewayAuth": {
      "tokenRef": "tok_task_weaver_prod",
      "actor": "task-weaver"
    }
  },
  "actor": "task-weaver"
}
```

The raw bearer token is never copied into gateway metadata, job records, events,
audit records, or error responses. Denied requests return only a short reason
such as missing scope or out-of-scope tenant/project.

When a token store is configured, every accepted or denied authorization
decision writes a `gateway_audit_records` row with route scope, token ref when
known, actor, tenant/project bounds, outcome, and reason.

## Deferred

- Operator UI on top of the CLI-backed lifecycle.
- Separate human/operator tokens.
