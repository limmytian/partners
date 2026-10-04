import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_SENSITIVE_FILENAMES,
  DEFAULT_SENSITIVE_PATTERNS,
  assertSafeWorkspacePath,
  assertSafeWorkspacePathSync,
  evaluateFileSensitivity,
  isSensitiveFile,
  redactSensitiveContent,
} from '../src/security/workspace-security.js';

test('isSensitiveFile identifies credentials and secrets correctly', () => {
  // Dotenv files
  assert.equal(isSensitiveFile('.env'), true);
  assert.equal(isSensitiveFile('.env.production'), true);
  assert.equal(isSensitiveFile('/workspace/.env.local'), true);
  assert.equal(isSensitiveFile('sub/dir/.env'), true);

  // Package tokens and configs
  assert.equal(isSensitiveFile('.npmrc'), true);
  assert.equal(isSensitiveFile('/workspace/.pypirc'), true);
  assert.equal(isSensitiveFile('.netrc'), true);
  assert.equal(isSensitiveFile('.git-credentials'), true);

  // Private keys
  assert.equal(isSensitiveFile('id_rsa'), true);
  assert.equal(isSensitiveFile('server.key'), true);
  assert.equal(isSensitiveFile('cert.pem'), true);
  assert.equal(isSensitiveFile('keystore.p12'), true);

  // Cloud configs
  assert.equal(isSensitiveFile('.aws/credentials'), true);
  assert.equal(isSensitiveFile('.kube/config'), true);
  assert.equal(isSensitiveFile('.docker/config.json'), true);

  // Normal safe files
  assert.equal(isSensitiveFile('README.md'), false);
  assert.equal(isSensitiveFile('package.json'), false);
  assert.equal(isSensitiveFile('src/index.js'), false);
  assert.equal(isSensitiveFile('config/app.json'), false);
});

test('evaluateFileSensitivity returns detailed policy decisions', () => {
  const safe = evaluateFileSensitivity('src/main.py');
  assert.equal(safe.isSensitive, false);
  assert.equal(safe.action, 'allow');
  assert.equal(safe.reason, null);

  const blocked = evaluateFileSensitivity('config/.env');
  assert.equal(blocked.isSensitive, true);
  assert.equal(blocked.action, 'block');
  assert.match(blocked.reason, /matches sensitive file security policy/);

  const customPolicy = evaluateFileSensitivity('config/.env', { action: 'redact' });
  assert.equal(customPolicy.action, 'redact');
});

test('redactSensitiveContent masks secrets and tokens', () => {
  const input = `
DATABASE_URL=postgres://user:super_secret_password@localhost:5432/db
API_KEY="sk_live_1234567890abcdef"
SLACK_TOKEN=xoxb-1234567890-abcdefghij
GITHUB_TOKEN=ghp_123456789012345678901234567890123456
AWS_KEY=AKIAIOSFODNN7EXAMPLE
-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0Y3
-----END RSA PRIVATE KEY-----
`;

  const redacted = redactSensitiveContent(input);
  assert.ok(!redacted.includes('super_secret_password'));
  assert.ok(!redacted.includes('sk_live_1234567890abcdef'));
  assert.ok(!redacted.includes('ghp_123456789012345678901234567890123456'));
  assert.ok(!redacted.includes('MIIEowIBAAKCAQEA0Y3'));
  assert.ok(redacted.includes('[REDACTED PRIVATE KEY]'));
  assert.ok(redacted.includes('[REDACTED GITHUB TOKEN]'));
});

test('assertSafeWorkspacePath validates boundaries and prevents traversal', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'partners-sec-test-'));

  try {
    // Normal files inside workspace
    const canonicalTempDir = await fs.realpath(tempDir);
    const inside = await assertSafeWorkspacePath(tempDir, 'sub/dir/file.txt');
    assert.equal(inside.relativePath, 'sub/dir/file.txt');
    assert.equal(inside.resolvedPath, path.resolve(canonicalTempDir, 'sub/dir/file.txt'));

    // Workspace prefix format
    const wsPrefix = await assertSafeWorkspacePath(tempDir, '/workspace/src/app.js');
    assert.equal(wsPrefix.relativePath, 'src/app.js');

    // Reject path traversal via ..
    await assert.rejects(
      () => assertSafeWorkspacePath(tempDir, '../outside.txt'),
      /Path escapes workspace boundary/
    );
    await assert.rejects(
      () => assertSafeWorkspacePath(tempDir, 'sub/../../outside.txt'),
      /Path escapes workspace boundary/
    );

    // Synchronous lexical check
    assert.equal(
      assertSafeWorkspacePathSync(tempDir, 'file.txt'),
      path.resolve(tempDir, 'file.txt')
    );
    assert.throws(
      () => assertSafeWorkspacePathSync(tempDir, '../outside.txt'),
      /Path escapes workspace boundary/
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('assertSafeWorkspacePath detects and prevents symlink escape', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'partners-symlink-test-'));
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'partners-outside-test-'));

  try {
    const outsideFile = path.join(outsideDir, 'secret.key');
    await fs.writeFile(outsideFile, 'secret content');

    // Create a symlink inside tempDir pointing outside
    const symlinkPath = path.join(tempDir, 'escape_link');
    await fs.symlink(outsideFile, symlinkPath);

    // Should reject the symlink escape
    await assert.rejects(
      () => assertSafeWorkspacePath(tempDir, 'escape_link'),
      /escapes workspace boundary/
    );

    // Symlink inside pointing to inside should be allowed
    const safeTarget = path.join(tempDir, 'internal.txt');
    await fs.writeFile(safeTarget, 'safe content');
    const safeLink = path.join(tempDir, 'safe_link');
    await fs.symlink(safeTarget, safeLink);

    const safeResult = await assertSafeWorkspacePath(tempDir, 'safe_link');
    assert.equal(safeResult.relativePath, 'safe_link');

    // Symlink directory escape
    const symlinkDir = path.join(tempDir, 'outside_dir');
    await fs.symlink(outsideDir, symlinkDir);
    await assert.rejects(
      () => assertSafeWorkspacePath(tempDir, 'outside_dir/secret.key'),
      /escapes workspace boundary/
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  }
});
