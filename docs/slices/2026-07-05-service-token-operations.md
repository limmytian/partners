# Gateway Service Token Operations Slice

Date: 2026-07-05

Requirement: Add gateway service-token operations.

## Scope

This slice adds operator-managed lifecycle workflows for gateway service tokens
backed by the existing `gateway_service_tokens` and `gateway_audit_records`
tables. It does not add a web operator UI.

## CLI Contract

Run with `POSTGRES_URL` or `--postgres-url`:

```bash
npm run gateway:token -- <command> [options]
```

Commands:

- `create --ref <ref> --actor <actor> --scope <scope>` creates a hashed token
  and prints `tokenValue` once.
- `list` and `show --ref <ref>` return public token metadata only.
- `update --ref <ref>` changes actor, scopes, tenant/project bounds, expiry, or
  metadata without changing the secret.
- `rotate --ref <old> --new-ref <new>` creates a replacement token. Add
  `--revoke-old` for emergency rotation.
- `revoke --ref <ref>` sets `revokedAt` and adds operation metadata.
- `audit --ref <ref>` lists token-related audit rows.

`--json` is available for automation. Raw tokens are never persisted, never
included in audit metadata, and are only printed by `create` and `rotate`.

## Runtime Changes

- `PostgresGatewayStore` now supports `getServiceToken`, `listServiceTokens`,
  and `revokeServiceToken` in addition to hash lookup and upsert.
- `gateway-token-operations.js` provides testable create/update/rotate/revoke
  operations and redacts `tokenHash` from public outputs.
- `scripts/gateway-token.mjs` is the operator CLI exposed as
  `npm run gateway:token`.

## Verification

- `npm test`
- Store-level tests cover create, update, rotate with old-token revoke, hash
  lookup rejection for revoked tokens, audit rows, and raw token redaction from
  persistence calls.
- `npm run gateway:token -- help`
