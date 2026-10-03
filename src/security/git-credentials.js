export const GitCredentialProvider = Object.freeze({
  GitHubApp: 'github_app',
  GitHubFineGrainedPat: 'github_pat_fg',
  GitLabProjectToken: 'gitlab_project_token',
  SshCertificate: 'ssh_certificate',
});

export const GitOperation = Object.freeze({
  Clone: 'clone',
  PushBranch: 'push_branch',
  CreatePullRequest: 'create_pr',
});

const SECRET_KEY_PATTERN = /(token|password|secret|privatekey|authorization|credential)/i;

export function createScopedGitCredentialGrant(input = {}) {
  assertKnownValue('provider', input.provider, GitCredentialProvider);
  assertRepository(input.repository);

  if (!input.tokenRef) {
    throw new TypeError('Credential grant requires tokenRef');
  }
  if (!input.expiresAt || Number.isNaN(new Date(input.expiresAt).getTime())) {
    throw new TypeError('Credential grant requires a valid expiresAt timestamp');
  }
  rejectRawSecretMaterial(input);

  const operations = input.operations ?? [GitOperation.Clone];
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new TypeError('Credential grant requires at least one operation');
  }
  for (const operation of operations) {
    assertKnownValue('operation', operation, GitOperation);
  }

  const allowedBranches = input.allowedBranches ?? ['codex/*'];
  if (!Array.isArray(allowedBranches) || allowedBranches.length === 0) {
    throw new TypeError('Credential grant requires at least one allowed branch pattern');
  }

  return {
    id: input.id ?? null,
    provider: input.provider,
    repository: {
      host: normalizeHost(input.repository.host),
      owner: input.repository.owner,
      name: stripGitSuffix(input.repository.name),
      defaultBranch: input.repository.defaultBranch ?? 'main',
    },
    operations: [...new Set(operations)],
    allowedBranches,
    allowDefaultBranchPush: input.allowDefaultBranchPush ?? false,
    expiresAt: input.expiresAt,
    tokenRef: input.tokenRef,
    metadata: input.metadata ?? {},
  };
}

export function assertGitOperationAllowed(grant, operation, context = {}) {
  const normalized = createScopedGitCredentialGrant(grant);
  assertKnownValue('operation', operation, GitOperation);

  if (!normalized.operations.includes(operation)) {
    throw new Error(`Git operation is not allowed by credential grant: ${operation}`);
  }
  if (isExpired(normalized, context.now)) {
    throw new Error('Git credential grant has expired');
  }
  if (context.remoteUrl && !remoteMatchesRepository(context.remoteUrl, normalized.repository)) {
    throw new Error('Git remote does not match credential grant repository');
  }

  if (operation === GitOperation.PushBranch) {
    assertBranchAllowed(normalized, context.branch);
  }
  if (operation === GitOperation.CreatePullRequest) {
    assertBranchAllowed(normalized, context.sourceBranch);
    const targetBranch = context.targetBranch ?? normalized.repository.defaultBranch;
    if (context.targetBranch && targetBranch !== normalized.repository.defaultBranch && !context.allowNonDefaultTarget) {
      throw new Error('Pull request target branch must be the repository default branch unless explicitly allowed');
    }
  }

  return true;
}

export function isGitOperationAllowed(grant, operation, context = {}) {
  try {
    assertGitOperationAllowed(grant, operation, context);
    return true;
  } catch {
    return false;
  }
}

export function buildGitCredentialInjection(grant) {
  const normalized = createScopedGitCredentialGrant(grant);
  return {
    mode: 'secret_ref_askpass',
    secretRef: normalized.tokenRef,
    host: normalized.repository.host,
    repositoryPath: `${normalized.repository.owner}/${normalized.repository.name}`,
    username: usernameForProvider(normalized.provider),
    persistCredentials: false,
    redactPatterns: [
      normalized.tokenRef,
      `${normalized.repository.host}/${normalized.repository.owner}/${normalized.repository.name}`,
    ],
  };
}

export function remoteMatchesRepository(remoteUrl, repository) {
  const parsed = parseGitRemoteUrl(remoteUrl);
  return parsed.host === normalizeHost(repository.host)
    && parsed.owner.toLowerCase() === repository.owner.toLowerCase()
    && stripGitSuffix(parsed.name).toLowerCase() === stripGitSuffix(repository.name).toLowerCase();
}

export function parseGitRemoteUrl(remoteUrl) {
  if (typeof remoteUrl !== 'string' || !remoteUrl.trim()) {
    throw new TypeError('Remote URL must be a non-empty string');
  }

  const trimmed = remoteUrl.trim();
  const scpLike = trimmed.match(/^git@([^:]+):([^/]+)\/(.+)$/);
  if (scpLike) {
    const pathParts = scpLike[3].split('/');
    return {
      protocol: 'ssh',
      host: normalizeHost(scpLike[1]),
      owner: [scpLike[2], ...pathParts.slice(0, -1)].join('/'),
      name: stripGitSuffix(pathParts.at(-1)),
    };
  }

  const parsed = new URL(trimmed);
  const pathParts = parsed.pathname.split('/').filter(Boolean);
  if (pathParts.length < 2) {
    throw new TypeError(`Remote URL must include owner and repository: ${remoteUrl}`);
  }

  return {
    protocol: parsed.protocol.replace(':', ''),
    host: normalizeHost(parsed.hostname),
    owner: pathParts.slice(0, -1).join('/'),
    name: stripGitSuffix(pathParts.at(-1)),
  };
}

export function redactGitCredentialMaterial(value) {
  if (typeof value === 'string') {
    return redactSensitiveGitText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactGitCredentialMaterial(item));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    SECRET_KEY_PATTERN.test(key) ? '[REDACTED]' : redactGitCredentialMaterial(item),
  ]));
}

export function redactSensitiveGitText(text) {
  return text
    .replace(/https:\/\/([^:\s/@]+):([^@\s]+)@/g, 'https://[REDACTED]@')
    .replace(/(Authorization:\s*)(Bearer|token)\s+[\w.:-]+/gi, '$1$2 [REDACTED]')
    .replace(/(gh[psuor]_[A-Za-z0-9_]+)/g, '[REDACTED]')
    .replace(/(glpat-[A-Za-z0-9_-]+)/g, '[REDACTED]');
}

function assertBranchAllowed(grant, branch) {
  if (!branch) {
    throw new Error('Git operation requires a branch');
  }
  if (branch === grant.repository.defaultBranch && !grant.allowDefaultBranchPush) {
    throw new Error('Direct default-branch publishing is not allowed');
  }
  if (!grant.allowedBranches.some((pattern) => branchMatchesPattern(branch, pattern))) {
    throw new Error(`Branch is not allowed by credential grant: ${branch}`);
  }
}

function branchMatchesPattern(branch, pattern) {
  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`).test(branch);
}

function isExpired(grant, now = new Date().toISOString()) {
  if (!grant.expiresAt) {
    return false;
  }
  return new Date(grant.expiresAt).getTime() <= new Date(now).getTime();
}

function assertRepository(repository) {
  if (!repository?.host || !repository?.owner || !repository?.name) {
    throw new TypeError('Credential grant requires repository host, owner, and name');
  }
}

function assertKnownValue(label, value, values) {
  if (!Object.values(values).includes(value)) {
    throw new TypeError(`Unsupported ${label}: ${value}`);
  }
}

function rejectRawSecretMaterial(value, path = []) {
  if (!value || typeof value !== 'object') {
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (key === 'tokenRef') {
      continue;
    }
    if (SECRET_KEY_PATTERN.test(key) && typeof item === 'string' && item) {
      throw new TypeError(`Credential grant must not contain raw secret material at ${[...path, key].join('.')}`);
    }
    rejectRawSecretMaterial(item, [...path, key]);
  }
}

function usernameForProvider(provider) {
  if (provider === GitCredentialProvider.GitHubApp) {
    return 'x-access-token';
  }
  if (provider === GitCredentialProvider.GitLabProjectToken) {
    return 'oauth2';
  }
  return 'git';
}

function normalizeHost(host) {
  return host.toLowerCase();
}

function stripGitSuffix(name) {
  return String(name).replace(/\.git$/i, '');
}
