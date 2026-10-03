import { randomBytes } from 'node:crypto';

export function generateGatewayServiceToken() {
  return `ptk_${randomBytes(32).toString('base64url')}`;
}

export async function createGatewayServiceToken(store, input = {}, context = {}) {
  const tokenRef = required(input.tokenRef, 'tokenRef');
  const rawToken = input.token ?? context.generateToken?.() ?? generateGatewayServiceToken();
  const scopes = normalizeList(input.scopes);
  if (scopes.length === 0) {
    throw new TypeError('At least one scope is required');
  }

  const record = await store.saveServiceToken({
    token: rawToken,
    tokenRef,
    actor: input.actor ?? tokenRef,
    scopes,
    tenantIds: normalizeList(input.tenantIds),
    projectIds: normalizeList(input.projectIds),
    expiresAt: normalizeNullableIso(input.expiresAt),
    metadata: operationMetadata(input.metadata, context, {
      operation: 'create',
    }),
  });
  await auditTokenOperation(store, 'token.create', record, context);
  return {
    token: publicServiceToken(record),
    tokenValue: rawToken,
  };
}

export async function updateGatewayServiceToken(store, input = {}, context = {}) {
  const tokenRef = required(input.tokenRef, 'tokenRef');
  const existing = await requireServiceToken(store, tokenRef);
  const record = await store.saveServiceToken({
    ...existing,
    actor: input.actor ?? existing.actor,
    scopes: input.scopes === undefined ? existing.scopes : normalizeList(input.scopes),
    tenantIds: input.tenantIds === undefined ? existing.tenantIds : normalizeList(input.tenantIds),
    projectIds: input.projectIds === undefined ? existing.projectIds : normalizeList(input.projectIds),
    expiresAt: input.expiresAt === undefined ? existing.expiresAt : normalizeNullableIso(input.expiresAt),
    metadata: operationMetadata({
      metadata: {
        ...existing.metadata,
        ...(input.metadata ?? {}),
      },
    }, context, {
      operation: 'update',
    }),
  });
  await auditTokenOperation(store, 'token.update', record, context);
  return publicServiceToken(record);
}

export async function revokeGatewayServiceToken(store, input = {}, context = {}) {
  const tokenRef = required(input.tokenRef, 'tokenRef');
  const record = await store.revokeServiceToken(tokenRef, {
    revokedAt: input.revokedAt ?? context.now?.() ?? new Date().toISOString(),
    metadata: operationMetadata(input, context, {
      operation: 'revoke',
      reason: input.reason ?? null,
    }),
  });
  if (!record) {
    throw new Error(`Service token not found: ${tokenRef}`);
  }
  await auditTokenOperation(store, 'token.revoke', record, context, input.reason);
  return publicServiceToken(record);
}

export async function rotateGatewayServiceToken(store, input = {}, context = {}) {
  const oldTokenRef = required(input.tokenRef, 'tokenRef');
  const newTokenRef = required(input.newTokenRef, 'newTokenRef');
  const existing = await requireServiceToken(store, oldTokenRef);
  const rawToken = input.token ?? context.generateToken?.() ?? generateGatewayServiceToken();
  const record = await store.saveServiceToken({
    token: rawToken,
    tokenRef: newTokenRef,
    actor: input.actor ?? existing.actor,
    scopes: input.scopes === undefined ? existing.scopes : normalizeList(input.scopes),
    tenantIds: input.tenantIds === undefined ? existing.tenantIds : normalizeList(input.tenantIds),
    projectIds: input.projectIds === undefined ? existing.projectIds : normalizeList(input.projectIds),
    expiresAt: input.expiresAt === undefined ? existing.expiresAt : normalizeNullableIso(input.expiresAt),
    metadata: operationMetadata({
      metadata: {
        ...existing.metadata,
        ...(input.metadata ?? {}),
        rotatedFrom: oldTokenRef,
      },
    }, context, {
      operation: 'rotate',
    }),
  });
  await auditTokenOperation(store, 'token.rotate', record, context, `rotated from ${oldTokenRef}`);

  let revoked = null;
  if (input.revokeOld) {
    revoked = await revokeGatewayServiceToken(store, {
      tokenRef: oldTokenRef,
      reason: `rotated to ${newTokenRef}`,
      revokedAt: input.revokedAt,
    }, context);
  }

  return {
    token: publicServiceToken(record),
    tokenValue: rawToken,
    revoked,
  };
}

export async function listGatewayServiceTokens(store, input = {}) {
  const items = await store.listServiceTokens({
    includeRevoked: input.includeRevoked ?? true,
    limit: input.limit ?? 100,
  });
  return items.map(publicServiceToken);
}

export async function listGatewayServiceTokenAudit(store, input = {}) {
  const items = await store.listAuditRecords({
    tokenRef: input.tokenRef,
    limit: input.limit ?? 100,
  });
  return items;
}

export function publicServiceToken(token) {
  if (!token) {
    return null;
  }
  const { tokenHash: _tokenHash, ...publicToken } = token;
  return {
    ...publicToken,
    scopes: [...(publicToken.scopes ?? [])],
    tenantIds: [...(publicToken.tenantIds ?? [])],
    projectIds: [...(publicToken.projectIds ?? [])],
    metadata: { ...(publicToken.metadata ?? {}) },
  };
}

async function requireServiceToken(store, tokenRef) {
  const token = await store.getServiceToken(tokenRef);
  if (!token) {
    throw new Error(`Service token not found: ${tokenRef}`);
  }
  return token;
}

async function auditTokenOperation(store, action, token, context, reason = null) {
  await store.recordAudit?.({
    action,
    scope: 'service-tokens:manage',
    tokenRef: token.tokenRef,
    actor: context.operator ?? 'gateway-token-cli',
    resourceType: 'gateway_service_token',
    resourceId: token.tokenRef,
    outcome: 'accepted',
    reason,
    metadata: {
      targetActor: token.actor,
      scopes: token.scopes,
      tenantIds: token.tenantIds,
      projectIds: token.projectIds,
    },
  });
}

function operationMetadata(input = {}, context = {}, extra = {}) {
  return {
    ...(input.metadata ?? {}),
    operations: [
      ...((input.metadata?.operations) ?? []),
      {
        at: context.now?.() ?? new Date().toISOString(),
        by: context.operator ?? 'gateway-token-cli',
        ...extra,
      },
    ],
  };
}

function normalizeList(value) {
  if (value === undefined || value === null) {
    return [];
  }
  const values = Array.isArray(value) ? value : [value];
  return values
    .flatMap((item) => String(item).split(','))
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeNullableIso(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (String(value).toLowerCase() === 'null') {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`Invalid ISO timestamp: ${value}`);
  }
  return date.toISOString();
}

function required(value, name) {
  if (!value) {
    throw new TypeError(`${name} is required`);
  }
  return value;
}
