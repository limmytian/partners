import { createHash } from 'node:crypto';

export const IdempotencyScope = Object.freeze({
  JobsCreate: 'jobs:create',
});

export const IDEMPOTENCY_HASH_ALGORITHM = 'sha256:stable-json-v1';
export const DEFAULT_IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._~:-]+$/;
const SECRET_FIELD_PATTERN = /(^|_)(authorization|bearer|token|secret|password|passwd|passphrase|privatekey|private_key|apikey|api_key|accesskey|access_key|sshkey|ssh_key)(_|$)/i;
const REDACTED = '[redacted]';

export function createIdempotencyContext({
  idempotencyKey,
  scope,
  request = {},
  tenantId = request?.tenantId ?? null,
  projectId = request?.projectId ?? null,
  now = new Date().toISOString(),
  ttlSeconds = DEFAULT_IDEMPOTENCY_TTL_SECONDS,
} = {}) {
  const externalKey = normalizeIdempotencyKey(idempotencyKey);
  const routeScope = assertScope(scope);
  const tenantScope = tenantId ?? null;
  const projectScope = projectId ?? null;
  const createdAt = timestamp(now);
  const expiresAt = new Date(createdAt.getTime() + ttlSeconds * 1000).toISOString();
  const scopeEnvelope = {
    scope: routeScope,
    tenantId: tenantScope,
    projectId: projectScope,
  };
  const normalizedRequest = normalizeIdempotencyRequest(request);

  return {
    idempotencyKey: externalKey,
    scope: routeScope,
    tenantId: tenantScope,
    projectId: projectScope,
    storeKey: `idem_${sha256(stableStringify({ ...scopeEnvelope, idempotencyKey: externalKey }))}`,
    requestHash: sha256(stableStringify({
      ...scopeEnvelope,
      body: normalizedRequest,
    })),
    requestHashAlgorithm: IDEMPOTENCY_HASH_ALGORITHM,
    normalizedRequest,
    createdAt: createdAt.toISOString(),
    expiresAt,
  };
}

export function createJobIdempotencyRecord({
  idempotencyKey,
  request = {},
  responseBody,
  statusCode = 202,
  resourceId = responseBody?.id ?? request?.id ?? null,
  now = new Date().toISOString(),
  ttlSeconds = DEFAULT_IDEMPOTENCY_TTL_SECONDS,
} = {}) {
  const context = createIdempotencyContext({
    idempotencyKey,
    scope: IdempotencyScope.JobsCreate,
    request,
    now,
    ttlSeconds,
  });

  return {
    storeKey: context.storeKey,
    record: {
      idempotencyKey: context.idempotencyKey,
      scope: context.scope,
      tenantId: context.tenantId,
      projectId: context.projectId,
      requestHash: context.requestHash,
      requestHashAlgorithm: context.requestHashAlgorithm,
      resourceType: 'job',
      resourceId,
      statusCode,
      responseBody: responseBody ?? null,
      createdAt: context.createdAt,
      expiresAt: context.expiresAt,
    },
  };
}

export function isIdempotencyRecordExpired(record, now = new Date().toISOString()) {
  if (!record?.expiresAt) {
    return false;
  }
  return timestamp(record.expiresAt).getTime() <= timestamp(now).getTime();
}

export function normalizeIdempotencyRequest(value) {
  return normalizeValue(value);
}

export function normalizeIdempotencyKey(value) {
  if (Array.isArray(value)) {
    throw new TypeError('Idempotency-Key must be a single header value');
  }
  if (typeof value !== 'string') {
    throw new TypeError('Idempotency-Key must be a string');
  }
  if (value.length < 8 || value.length > 200) {
    throw new TypeError('Idempotency-Key must be between 8 and 200 characters');
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new TypeError('Idempotency-Key contains unsupported characters');
  }
  return value;
}

function normalizeValue(value, key = '') {
  if (value === undefined) {
    return null;
  }
  if (value === null || typeof value !== 'object') {
    return shouldRedact(key) ? REDACTED : value;
  }
  if (shouldRedact(key)) {
    return REDACTED;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeValue(item));
  }

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((entryKey) => value[entryKey] !== undefined)
      .filter((entryKey) => !(key === 'metadata' && entryKey === 'gatewayAuth'))
      .map((entryKey) => [entryKey, normalizeValue(value[entryKey], entryKey)]),
  );
}

function shouldRedact(key) {
  return SECRET_FIELD_PATTERN.test(key);
}

function assertScope(scope) {
  if (!scope || typeof scope !== 'string') {
    throw new TypeError('Idempotency scope is required');
  }
  return scope;
}

function stableStringify(value) {
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function timestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`Invalid idempotency timestamp: ${value}`);
  }
  return date;
}
