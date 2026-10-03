#!/usr/bin/env node

import {
  createAgentExecutionGatewayServer,
  GatewayServiceAuthorizer,
  InMemoryAgentExecutionGateway,
  InMemoryGatewayStore,
  KubernetesSandboxProvider,
  LocalArtifactStore,
  LocalSandboxProvider,
  PostgresGatewayStore,
  S3ArtifactStore,
  createGatewayMetrics,
  instrumentArtifactStore,
} from '../src/index.js';

const host = process.env.GATEWAY_HOST ?? '0.0.0.0';
const port = parseInteger(process.env.GATEWAY_PORT, 8080);
const workRoot = process.env.GATEWAY_WORK_ROOT ?? '/tmp/partners-workspaces';
const artifactRoot = process.env.GATEWAY_ARTIFACT_ROOT ?? '/tmp/partners-artifacts';
const serviceTokens = buildServiceTokens();
const { store, storeKind } = await buildGatewayStore(serviceTokens);
const { artifactStore, artifactStoreKind } = buildArtifactStore();
const metrics = createGatewayMetrics({
  storeStats: () => store.stats?.() ?? null,
});
const measuredArtifactStore = instrumentArtifactStore(artifactStore, metrics, {
  backend: artifactStoreKind,
});
let ready = false;
const provider = buildProvider({ workRoot });
await provider.reconcile?.();

const gateway = new InMemoryAgentExecutionGateway({
  provider,
  store,
  artifactStore: measuredArtifactStore,
  metrics,
});

const app = createAgentExecutionGatewayServer({
  gateway,
  logger: createJsonLogger(),
  metrics,
  readiness: async () => readinessStatus(),
  authorizer: new GatewayServiceAuthorizer({
    tokens: storeKind === 'postgres' ? [] : serviceTokens,
    tokenStore: storeKind === 'postgres' ? store : null,
  }),
});

await new Promise((resolve) => app.listen(port, host, resolve));
ready = true;

log('info', 'gateway started', {
  host,
  port,
  authEnabled: Boolean(process.env.GATEWAY_SERVICE_TOKEN),
  storeKind,
  artifactStoreKind,
  workRoot,
  artifactRoot,
  postgresConfigured: Boolean(process.env.POSTGRES_URL),
  s3Configured: Boolean(process.env.S3_ENDPOINT && process.env.S3_BUCKET),
  provider: provider.name,
});

let stopping = false;
async function stop(signal) {
  if (stopping) {
    return;
  }
  stopping = true;
  ready = false;
  log('info', 'gateway stopping', { signal });
  try {
    await app.close();
    await store.close?.();
    await measuredArtifactStore.close?.();
    log('info', 'gateway stopped', { signal });
    process.exit(0);
  } catch (error) {
    log('error', 'gateway stop failed', { signal, error: error.message });
    process.exit(1);
  }
}

process.once('SIGINT', () => {
  void stop('SIGINT');
});
process.once('SIGTERM', () => {
  void stop('SIGTERM');
});

async function buildGatewayStore(tokens) {
  const requested = (process.env.GATEWAY_STORE ?? 'memory').toLowerCase();
  if (requested !== 'postgres') {
    return { store: new InMemoryGatewayStore(), storeKind: 'memory' };
  }
  const store = new PostgresGatewayStore({ connectionString: process.env.POSTGRES_URL });
  await store.migrate();
  for (const token of tokens) {
    await store.saveServiceToken(token);
  }
  return { store, storeKind: 'postgres' };
}

function buildArtifactStore() {
  const requested = (process.env.GATEWAY_ARTIFACT_STORE ?? 'local').toLowerCase();
  if (requested !== 's3') {
    return {
      artifactStore: new LocalArtifactStore({ rootDir: artifactRoot }),
      artifactStoreKind: 'local',
    };
  }
  return {
    artifactStore: new S3ArtifactStore({
      endpoint: process.env.S3_ENDPOINT,
      bucket: process.env.S3_BUCKET,
      region: process.env.S3_REGION ?? 'us-east-1',
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      prefix: process.env.S3_PREFIX ?? 'gateway-artifacts',
    }),
    artifactStoreKind: 's3',
  };
}

function buildServiceTokens() {
  const token = process.env.GATEWAY_SERVICE_TOKEN;
  if (!token) {
    return [];
  }

  return [{
    token,
    tokenRef: process.env.GATEWAY_SERVICE_TOKEN_REF ?? 'env-service-token',
    actor: process.env.GATEWAY_SERVICE_ACTOR ?? 'gateway-service',
    scopes: parseList(process.env.GATEWAY_SERVICE_SCOPES, ['*']),
    tenantIds: parseList(process.env.GATEWAY_TENANT_IDS),
    projectIds: parseList(process.env.GATEWAY_PROJECT_IDS),
    expiresAt: process.env.GATEWAY_SERVICE_TOKEN_EXPIRES_AT ?? null,
  }];
}

function buildProvider({ workRoot: rootDir }) {
  const requested = (process.env.GATEWAY_PROVIDER ?? 'local').toLowerCase();
  if (requested === 'kubernetes' || requested === 'k8s') {
    return new KubernetesSandboxProvider();
  }
  if (requested !== 'local') {
    throw new Error(`Unsupported GATEWAY_PROVIDER: ${requested}`);
  }
  return new LocalSandboxProvider({ rootDir });
}

async function readinessStatus() {
  const storeHealth = await store.healthCheck?.();
  const artifactHealth = await artifactStore.healthCheck?.();
  const dependenciesReady = [storeHealth, artifactHealth]
    .filter(Boolean)
    .every((health) => health.status === 'ready');
  return {
    status: ready && dependenciesReady ? 'ready' : 'starting',
    store: storeKind,
    storeHealth: storeHealth ?? undefined,
    artifactStore: artifactStoreKind,
    artifactStoreHealth: artifactHealth ?? undefined,
  };
}

function createJsonLogger() {
  return {
    info: (fields) => log('info', fields.message ?? 'info', fields),
    error: (error) => log('error', error?.message ?? 'error', { stack: error?.stack }),
  };
}

function parseList(value, fallback = []) {
  if (!value) {
    return fallback;
  }
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function log(level, message, fields = {}) {
  const payload = {
    level,
    message,
    at: new Date().toISOString(),
    ...fields,
  };
  const line = JSON.stringify(payload);
  if (level === 'error') {
    console.error(line);
    return;
  }
  console.log(line);
}
