import { createHash, timingSafeEqual } from 'node:crypto';

export class GatewayServiceAuthorizer {
  constructor({ tokens = [], tokenStore = null, clock = () => new Date() } = {}) {
    this.clock = clock;
    this.tokenStore = tokenStore;
    this.tokens = tokens.map(normalizeToken);
  }

  get enabled() {
    return this.tokens.length > 0 || Boolean(this.tokenStore);
  }

  async authorize({ headers = {}, scope, tenantId, projectId } = {}) {
    if (!this.enabled) {
      return {
        tokenRef: 'auth-disabled',
        actor: 'anonymous',
        scopes: ['*'],
        tenantId: tenantId ?? null,
        projectId: projectId ?? null,
      };
    }

    const bearer = parseBearer(headers.authorization);
    if (!bearer) {
      await this.#recordAudit({ scope, tenantId, projectId, outcome: 'denied', reason: 'Missing bearer token' });
      throw authError(401, 'Missing bearer token');
    }

    const tokenHash = hashGatewayServiceToken(bearer);
    const token = await this.#findToken(tokenHash);
    if (!token) {
      await this.#recordAudit({ scope, tenantId, projectId, outcome: 'denied', reason: 'Invalid bearer token' });
      throw authError(401, 'Invalid bearer token');
    }
    if (token.expiresAt && new Date(token.expiresAt) <= this.clock()) {
      await this.#recordAudit({ scope, tenantId, projectId, token, outcome: 'denied', reason: 'Bearer token expired' });
      throw authError(401, 'Bearer token expired');
    }
    if (token.revokedAt) {
      await this.#recordAudit({ scope, tenantId, projectId, token, outcome: 'denied', reason: 'Bearer token revoked' });
      throw authError(401, 'Bearer token revoked');
    }
    if (!hasScope(token.scopes, scope)) {
      await this.#recordAudit({ scope, tenantId, projectId, token, outcome: 'denied', reason: `Missing required scope: ${scope}` });
      throw authError(403, `Missing required scope: ${scope}`);
    }
    if (tenantId && token.tenantIds.length > 0 && !token.tenantIds.includes(tenantId)) {
      await this.#recordAudit({ scope, tenantId, projectId, token, outcome: 'denied', reason: 'Tenant is outside token scope' });
      throw authError(403, 'Tenant is outside token scope');
    }
    if (projectId && token.projectIds.length > 0 && !token.projectIds.includes(projectId)) {
      await this.#recordAudit({ scope, tenantId, projectId, token, outcome: 'denied', reason: 'Project is outside token scope' });
      throw authError(403, 'Project is outside token scope');
    }

    await this.#recordAudit({ scope, tenantId, projectId, token, outcome: 'accepted' });

    return {
      tokenRef: token.tokenRef,
      actor: token.actor,
      scopes: [...token.scopes],
      tenantId: tenantId ?? null,
      projectId: projectId ?? null,
    };
  }

  async #findToken(tokenHash) {
    const inMemory = this.tokens.find((candidate) => safeEqual(candidate.tokenHash, tokenHash));
    return inMemory ?? (await this.tokenStore?.getServiceTokenByHash(tokenHash)) ?? null;
  }

  async #recordAudit({ scope, tenantId, projectId, token, outcome, reason }) {
    await this.tokenStore?.recordAudit?.({
      action: 'authorize',
      scope,
      tokenRef: token?.tokenRef ?? null,
      actor: token?.actor ?? null,
      tenantId: tenantId ?? null,
      projectId: projectId ?? null,
      outcome,
      reason: reason ?? null,
    });
  }
}

export function redactAuthError(error) {
  return {
    error: error?.message ?? 'Authorization failed',
  };
}

export function hashGatewayServiceToken(token) {
  if (!token) {
    throw new TypeError('Gateway service token requires token or tokenHash');
  }
  return createHash('sha256').update(token).digest('hex');
}

function normalizeToken(token) {
  if (!token.token && !token.tokenHash) {
    throw new TypeError('Gateway service token requires token or tokenHash');
  }
  return {
    tokenHash: token.tokenHash ?? hashGatewayServiceToken(token.token),
    tokenRef: token.tokenRef ?? 'service-token',
    actor: token.actor ?? token.tokenRef ?? 'service-token',
    scopes: token.scopes ?? [],
    tenantIds: token.tenantIds ?? [],
    projectIds: token.projectIds ?? [],
    expiresAt: token.expiresAt ?? null,
    revokedAt: token.revokedAt ?? null,
  };
}

function parseBearer(value) {
  const raw = Array.isArray(value) ? value.at(-1) : value;
  const match = /^Bearer\s+(.+)$/i.exec(raw ?? '');
  return match?.[1] ?? null;
}

function hasScope(scopes, required) {
  return scopes.includes('*') || scopes.includes(required);
}

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function authError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}
