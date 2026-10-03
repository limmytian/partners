import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GitCredentialProvider,
  GitOperation,
  assertGitOperationAllowed,
  buildGitCredentialInjection,
  createScopedGitCredentialGrant,
  isGitOperationAllowed,
  parseGitRemoteUrl,
  redactGitCredentialMaterial,
  remoteMatchesRepository,
} from '../src/index.js';

const now = '2026-07-05T06:00:00.000Z';

test('allows clone and codex branch push for one repository grant', () => {
  const grant = createScopedGitCredentialGrant({
    id: 'gitcred_1',
    provider: GitCredentialProvider.GitHubApp,
    repository: {
      host: 'github.com',
      owner: 'Example',
      name: 'Repo.git',
      defaultBranch: 'main',
    },
    operations: [GitOperation.Clone, GitOperation.PushBranch, GitOperation.CreatePullRequest],
    expiresAt: '2026-07-05T07:00:00.000Z',
    tokenRef: 'secret://vault/gitcred_1',
  });

  assert.equal(grant.repository.name, 'Repo');
  assert.equal(assertGitOperationAllowed(grant, GitOperation.Clone, {
    remoteUrl: 'https://github.com/example/repo.git',
    now,
  }), true);
  assert.equal(assertGitOperationAllowed(grant, GitOperation.PushBranch, {
    remoteUrl: 'git@github.com:example/repo.git',
    branch: 'codex/repository-workspaces',
    now,
  }), true);
  assert.equal(assertGitOperationAllowed(grant, GitOperation.CreatePullRequest, {
    remoteUrl: 'https://github.com/example/repo.git',
    sourceBranch: 'codex/repository-workspaces',
    targetBranch: 'main',
    now,
  }), true);
});

test('denies default branch pushes, repository mismatch, and expired grants', () => {
  const grant = createScopedGitCredentialGrant({
    provider: GitCredentialProvider.GitLabProjectToken,
    repository: { host: 'gitlab.com', owner: 'team', name: 'repo', defaultBranch: 'main' },
    operations: [GitOperation.Clone, GitOperation.PushBranch],
    expiresAt: '2026-07-05T07:00:00.000Z',
    tokenRef: 'secret://vault/gitlab/repo',
  });

  assert.throws(() => assertGitOperationAllowed(grant, GitOperation.PushBranch, {
    branch: 'main',
    now,
  }), /default-branch/);
  assert.equal(isGitOperationAllowed(grant, GitOperation.PushBranch, {
    remoteUrl: 'https://gitlab.com/team/other.git',
    branch: 'codex/change',
    now,
  }), false);
  assert.equal(isGitOperationAllowed(grant, GitOperation.Clone, {
    remoteUrl: 'https://gitlab.com/team/repo.git',
    now: '2026-07-05T08:00:00.000Z',
  }), false);
});

test('builds credential injection without raw secret material', () => {
  const grant = createScopedGitCredentialGrant({
    provider: GitCredentialProvider.GitHubApp,
    repository: { host: 'github.com', owner: 'example', name: 'repo' },
    operations: [GitOperation.Clone],
    expiresAt: '2026-07-05T07:00:00.000Z',
    tokenRef: 'secret://vault/gitcred_2',
  });

  const injection = buildGitCredentialInjection(grant);
  assert.equal(injection.mode, 'secret_ref_askpass');
  assert.equal(injection.username, 'x-access-token');
  assert.equal(injection.persistCredentials, false);
  assert.equal(injection.secretRef, 'secret://vault/gitcred_2');
});

test('parses remotes and redacts credential material', () => {
  assert.deepEqual(parseGitRemoteUrl('git@github.com:Example/Repo.git'), {
    protocol: 'ssh',
    host: 'github.com',
    owner: 'Example',
    name: 'Repo',
  });
  assert.equal(remoteMatchesRepository('https://github.com/example/repo.git', {
    host: 'github.com',
    owner: 'example',
    name: 'repo',
  }), true);
  assert.equal(remoteMatchesRepository('git@gitlab.com:team/subgroup/repo.git', {
    host: 'gitlab.com',
    owner: 'team/subgroup',
    name: 'repo',
  }), true);

  const redacted = redactGitCredentialMaterial({
    remote: 'https://user:ghp_abcd1234@github.com/example/repo.git',
    nested: {
      tokenRef: 'secret://vault/gitcred_3',
      authorization: 'Bearer ghs_APPID_JWT',
    },
  });

  assert.equal(redacted.remote, 'https://[REDACTED]@github.com/example/repo.git');
  assert.equal(redacted.nested.tokenRef, '[REDACTED]');
  assert.equal(redacted.nested.authorization, '[REDACTED]');
});

test('rejects grants that accidentally carry raw secrets', () => {
  assert.throws(() => createScopedGitCredentialGrant({
    provider: GitCredentialProvider.GitHubFineGrainedPat,
    repository: { host: 'github.com', owner: 'example', name: 'repo' },
    operations: [GitOperation.Clone],
    expiresAt: '2026-07-05T07:00:00.000Z',
    tokenRef: 'secret://vault/ref',
    tokenValue: 'ghp_abcd',
  }), /raw secret material/);
});

test('requires credential grants to expire', () => {
  assert.throws(() => createScopedGitCredentialGrant({
    provider: GitCredentialProvider.GitHubApp,
    repository: { host: 'github.com', owner: 'example', name: 'repo' },
    operations: [GitOperation.Clone],
    tokenRef: 'secret://vault/ref',
  }), /valid expiresAt/);
});
