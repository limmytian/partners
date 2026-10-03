export const ExecutionMode = Object.freeze({
  EphemeralInterpreter: 'ephemeral_interpreter',
  WorkspaceSession: 'workspace_session',
});

export const JobState = Object.freeze({
  Queued: 'queued',
  Preparing: 'preparing',
  Running: 'running',
  CancelRequested: 'cancel_requested',
  Cancelled: 'cancelled',
  Succeeded: 'succeeded',
  Failed: 'failed',
  TimedOut: 'timed_out',
});

export const SessionState = Object.freeze({
  Provisioning: 'provisioning',
  Ready: 'ready',
  Busy: 'busy',
  Stopped: 'stopped',
  Deleted: 'deleted',
  Failed: 'failed',
});

export const ArtifactKind = Object.freeze({
  Stdout: 'stdout',
  Stderr: 'stderr',
  File: 'file',
  DirectoryArchive: 'directory_archive',
  Log: 'log',
  Metadata: 'metadata',
});

/**
 * Contract every custom sandbox image must expose to the gateway provider.
 * Keeping this in the provider-neutral contract prevents an image-specific
 * implementation from accidentally widening the control-plane API.
 */
export const SandboxAgentContract = Object.freeze({
  port: 8081,
  workspacePath: '/workspace',
  endpoints: Object.freeze({
    health: '/health',
    writeFile: '/v1/files/write',
    readFile: '/v1/files/read',
    exec: '/v1/exec',
    cancel: '/v1/cancel',
  }),
  required: Object.freeze([
    '/health',
    '/v1/files/write',
    '/v1/files/read',
    '/v1/exec',
    '/v1/cancel',
    '/workspace',
  ]),
});

const IMAGE_DIGEST_PATTERN = /^(?<repository>[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?(?::[0-9]+)?\/[a-z0-9][a-z0-9._\/-]*?)@sha256:(?<digest>[a-f0-9]{64})$/i;
const PROFILE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RAW_SECRET_KEY_PATTERN = /(password|token|private[._-]?key|authorization|credential|access[._-]?key|secret)/i;
const RAW_SECRET_VALUE_PATTERN = /(?:gh[psuor]_[A-Za-z0-9_]+|glpat-[A-Za-z0-9_-]+|AKIA[0-9A-Z]{16}|-----BEGIN [^-]+ PRIVATE KEY-----)/;

/**
 * Validate the provider-neutral sandbox configuration.  Policy-specific
 * allowlists are passed by the provider; the default only enforces the
 * immutable-image and secret-reference shape when those fields are used.
 */
export function assertSandboxConfiguration(config, {
  allowedRegistries = [],
  allowedProfiles = [],
  requireDigest = true,
  requireRegistryAllowlist = false,
} = {}) {
  if (config === undefined || config === null) {
    return undefined;
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('sandbox configuration must be an object');
  }
  rejectRawSecretMaterial(config);

  const unknown = Object.keys(config).filter((key) => ![
    'profile', 'image', 'imagePullSecretRef', 'imagePullPolicy', 'architecture',
    'init', 'agentContract',
  ].includes(key));
  if (unknown.length) {
    throw new TypeError(`Unsupported sandbox configuration field: ${unknown[0]}`);
  }

  if (config.profile !== undefined) {
    if (typeof config.profile !== 'string' || !PROFILE_PATTERN.test(config.profile)) {
      throw new TypeError('sandbox.profile must be a lowercase profile identifier');
    }
    if (allowedProfiles.length && !allowedProfiles.includes(config.profile)) {
      throw new TypeError(`sandbox.profile is not allowed: ${config.profile}`);
    }
  }

  if (config.image !== undefined) {
    assertImmutableSandboxImage(config.image, {
      allowedRegistries,
      requireDigest,
      requireRegistryAllowlist,
    });
  }

  if (config.imagePullSecretRef !== undefined
    && (typeof config.imagePullSecretRef !== 'string' || !REF_PATTERN.test(config.imagePullSecretRef))) {
    throw new TypeError('sandbox.imagePullSecretRef must be a server-side secret reference');
  }

  if (config.imagePullPolicy !== undefined
    && !['Always', 'IfNotPresent', 'Never'].includes(config.imagePullPolicy)) {
    throw new TypeError('sandbox.imagePullPolicy must be Always, IfNotPresent, or Never');
  }

  if (config.architecture !== undefined
    && !['amd64', 'arm64', 'arm', 'ppc64le', 's390x'].includes(config.architecture)) {
    throw new TypeError('sandbox.architecture is not a supported Kubernetes architecture');
  }

  if (config.init !== undefined) {
    assertSandboxInit(config.init);
  }

  if (config.agentContract !== undefined) {
    assertSandboxAgentContract(config.agentContract);
  }
  return true;
}

export function assertImmutableSandboxImage(image, {
  allowedRegistries = [],
  requireDigest = true,
  requireRegistryAllowlist = false,
} = {}) {
  if (typeof image !== 'string' || !image.trim()) {
    throw new TypeError('sandbox.image must be a non-empty image reference');
  }
  const value = image.trim();
  const match = value.match(IMAGE_DIGEST_PATTERN);
  if (requireDigest && !match) {
    throw new TypeError('sandbox.image must use an immutable @sha256:<64-hex-digest> reference');
  }
  const registry = registryForImage(value);
  if (!registry) {
    throw new TypeError('sandbox.image must include an explicit registry hostname');
  }
  if (requireRegistryAllowlist && !allowedRegistries.length) {
    throw new TypeError('sandbox.image requires a configured Registry allowlist');
  }
  if (allowedRegistries.length && !allowedRegistries.map(normalizeRegistry).includes(registry)) {
    throw new TypeError(`sandbox.image registry is not allowed: ${registry}`);
  }
  return { image: value, registry, digest: match?.groups?.digest ?? null };
}

export function assertSandboxInit(init) {
  if (!init || typeof init !== 'object' || Array.isArray(init)) {
    throw new TypeError('sandbox.init must be an object');
  }
  const unknown = Object.keys(init).filter((key) => ![
    'files', 'argv', 'env', 'timeoutSeconds', 'idempotencyKey', 'version',
  ].includes(key));
  if (unknown.length) {
    throw new TypeError(`Unsupported sandbox.init field: ${unknown[0]}`);
  }
  if (init.files !== undefined) {
    if (!Array.isArray(init.files) || init.files.length > 64) {
      throw new TypeError('sandbox.init.files must contain at most 64 files');
    }
    for (const file of init.files) {
      assertSandboxInitFile(file);
    }
  }
  if (init.argv !== undefined) {
    if (!Array.isArray(init.argv) || init.argv.length === 0 || init.argv.length > 64
      || init.argv.some((item) => typeof item !== 'string' || !item.length || item.length > 4096)) {
      throw new TypeError('sandbox.init.argv must contain 1-64 non-empty strings');
    }
  }
  if (init.env !== undefined) {
    if (!init.env || typeof init.env !== 'object' || Array.isArray(init.env)) {
      throw new TypeError('sandbox.init.env must be an object');
    }
    for (const [key, value] of Object.entries(init.env)) {
      if (!ENV_KEY_PATTERN.test(key) || typeof value !== 'string' || value.length > 16384) {
        throw new TypeError(`sandbox.init.env contains an invalid entry: ${key}`);
      }
    }
  }
  if (init.timeoutSeconds !== undefined
    && (!Number.isInteger(init.timeoutSeconds) || init.timeoutSeconds < 1 || init.timeoutSeconds > 900)) {
    throw new TypeError('sandbox.init.timeoutSeconds must be an integer between 1 and 900');
  }
  if (init.idempotencyKey !== undefined
    && (typeof init.idempotencyKey !== 'string' || !/^[A-Za-z0-9._~:-]{8,200}$/.test(init.idempotencyKey))) {
    throw new TypeError('sandbox.init.idempotencyKey must be 8-200 safe characters');
  }
  if (init.version !== undefined
    && (typeof init.version !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(init.version))) {
    throw new TypeError('sandbox.init.version must be a short identifier');
  }
  return true;
}

export function assertSandboxInitFile(file) {
  if (!file || typeof file !== 'object' || Array.isArray(file) || typeof file.path !== 'string') {
    throw new TypeError('sandbox.init.files entries require a path');
  }
  if (!isSandboxWorkspacePath(file.path)) {
    throw new TypeError(`sandbox.init file path must stay under /workspace: ${file.path}`);
  }
  const hasContent = typeof file.content === 'string';
  const hasBase64 = typeof file.contentBase64 === 'string';
  if (hasContent === hasBase64) {
    throw new TypeError('sandbox.init file requires exactly one of content or contentBase64');
  }
  if (file.content?.length > 4 * 1024 * 1024 || file.contentBase64?.length > 6 * 1024 * 1024) {
    throw new TypeError('sandbox.init file content exceeds 4 MiB');
  }
  return true;
}

export function assertSandboxAgentContract(contract = {}) {
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
    throw new TypeError('sandbox.agentContract must be an object');
  }
  if (contract.port !== undefined && contract.port !== SandboxAgentContract.port) {
    throw new TypeError(`sandbox.agentContract.port must be ${SandboxAgentContract.port}`);
  }
  if (contract.workspacePath !== undefined && contract.workspacePath !== SandboxAgentContract.workspacePath) {
    throw new TypeError(`sandbox.agentContract.workspacePath must be ${SandboxAgentContract.workspacePath}`);
  }
  return true;
}

export function normalizeSandboxConfiguration(config) {
  if (config === undefined || config === null) {
    return undefined;
  }
  assertSandboxConfiguration(config);
  return {
    ...(config.profile !== undefined ? { profile: config.profile } : {}),
    ...(config.image !== undefined ? { image: config.image.trim() } : {}),
    ...(config.imagePullSecretRef !== undefined ? { imagePullSecretRef: config.imagePullSecretRef } : {}),
    ...(config.imagePullPolicy !== undefined ? { imagePullPolicy: config.imagePullPolicy } : {}),
    ...(config.architecture !== undefined ? { architecture: config.architecture } : {}),
    ...(config.agentContract !== undefined ? { agentContract: { ...config.agentContract } } : {}),
    ...(config.init !== undefined ? {
      init: {
        ...(config.init.files !== undefined ? { files: config.init.files.map((file) => ({ ...file })) } : {}),
        ...(config.init.argv !== undefined ? { argv: [...config.init.argv] } : {}),
        ...(config.init.env !== undefined ? { env: { ...config.init.env } } : {}),
        ...(config.init.timeoutSeconds !== undefined ? { timeoutSeconds: config.init.timeoutSeconds } : {}),
        ...(config.init.idempotencyKey !== undefined ? { idempotencyKey: config.init.idempotencyKey } : {}),
        ...(config.init.version !== undefined ? { version: config.init.version } : {}),
      },
    } : {}),
  };
}

export function isSandboxWorkspacePath(value) {
  return typeof value === 'string'
    && (value === '/workspace' || value.startsWith('/workspace/'))
    && !value.split('/').includes('..')
    && !value.includes('\\')
    && !value.includes('\0');
}

function registryForImage(image) {
  const first = image.split('/')[0];
  return first.includes('.') || first.includes(':') || first === 'localhost'
    ? normalizeRegistry(first)
    : null;
}

function normalizeRegistry(value) {
  return String(value).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function rejectRawSecretMaterial(value, path = []) {
  if (typeof value === 'string') {
    if (RAW_SECRET_VALUE_PATTERN.test(value)) {
      throw new TypeError(`Sandbox configuration must not contain raw secret material at ${path.join('.') || 'sandbox'}`);
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    const isReference = /ref$/i.test(key) || /refs$/i.test(key);
    if (!isReference && RAW_SECRET_KEY_PATTERN.test(key) && typeof item === 'string' && item) {
      throw new TypeError(`Sandbox configuration must use secret references at ${[...path, key].join('.')}`);
    }
    rejectRawSecretMaterial(item, [...path, key]);
  }
}

export function createEvent(type, payload = {}, sequence = 0) {
  return {
    id: `${sequence}`,
    type,
    sequence,
    at: new Date().toISOString(),
    ...payload,
  };
}

export function assertExecutionJobRequest(request) {
  if (!request || typeof request !== 'object') {
    throw new TypeError('Execution job request is required');
  }

  if (!Object.values(ExecutionMode).includes(request.executionMode)) {
    throw new TypeError(`Unsupported execution mode: ${request.executionMode}`);
  }

  if (!request.command && !request.code) {
    throw new TypeError('Execution job request requires command or code');
  }

  if (!Number.isInteger(request.timeoutSeconds) || request.timeoutSeconds <= 0) {
    throw new TypeError('Execution job request requires positive timeoutSeconds');
  }

  assertSandboxConfiguration(request.sandbox);
}

export function assertExecutionSessionRequest(request) {
  if (!request || typeof request !== 'object') {
    throw new TypeError('Execution session request is required');
  }
  if (!request.tenantId || typeof request.tenantId !== 'string') {
    throw new TypeError('Execution session request requires tenantId');
  }
  if (!request.projectId || typeof request.projectId !== 'string') {
    throw new TypeError('Execution session request requires projectId');
  }
  assertSandboxConfiguration(request.sandbox);
}

export function commandToShell(command) {
  if (!command?.argv?.length) {
    throw new TypeError('Command argv must contain at least one item');
  }

  return command.argv.map(shellQuote).join(' ');
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) {
    return value;
  }

  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
