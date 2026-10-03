import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ArtifactRetentionClass,
  WorkspaceArtifactKind,
  WorkspacePersistenceKind,
  buildArtifactManifest,
  buildRepositoryWorkspacePlan,
  normalizeWorkspacePath,
  toWorkspaceUri,
} from '../src/index.js';

test('builds an isolated repository workspace plan with durable artifacts', () => {
  const workspace = buildRepositoryWorkspacePlan({
    jobId: 'job_123',
    repository: { url: 'https://github.com/example/repo.git', branch: 'main' },
    artifactBaseUri: 'object://partners-artifacts/jobs/job_123/',
    persistence: { kind: WorkspacePersistenceKind.Ephemeral },
  });

  assert.equal(workspace.workspaceId, 'ws_job-123');
  assert.equal(workspace.persistence.cleanup, 'after_job');
  assert.equal(workspace.checkoutPath, '/workspace/repo');
  assert.equal(workspace.checkoutUri, 'workspace:/workspace/repo');
  assert.equal(workspace.artifacts.baseUri, 'object://partners-artifacts/jobs/job_123');
  assert.ok(workspace.artifacts.collect.some((item) => item.kind === WorkspaceArtifactKind.Patch));
});

test('builds an artifact manifest with retention and storage URIs', () => {
  const workspace = buildRepositoryWorkspacePlan({
    workspaceId: 'ws_review',
    sessionId: 'ses_1',
    artifactBaseUri: 'artifact://ws_review',
    retentionClass: ArtifactRetentionClass.Audit,
  });

  const manifest = buildArtifactManifest({
    workspace,
    now: '2026-07-05T06:00:00.000Z',
    publish: { branch: 'codex/ws-review', commitSha: 'abc123' },
    artifacts: [
      {
        kind: WorkspaceArtifactKind.Log,
        name: 'stdout.txt',
        workspacePath: '/workspace/.partners/logs/stdout.txt',
        sizeBytes: 42,
      },
      {
        kind: WorkspaceArtifactKind.BranchRef,
        name: 'publish.json',
        workspacePath: '/workspace/.partners/publish.json',
        retentionClass: ArtifactRetentionClass.Audit,
      },
    ],
  });

  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.sessionId, 'ses_1');
  assert.equal(manifest.retentionClass, ArtifactRetentionClass.Audit);
  assert.equal(manifest.artifacts[0].storageUri, 'artifact://ws_review/stdout.txt');
  assert.equal(manifest.artifacts[1].contentType, 'application/json');
  assert.deepEqual(manifest.publish, { branch: 'codex/ws-review', commitSha: 'abc123' });
});

test('normalizes workspace paths without allowing escape', () => {
  assert.equal(normalizeWorkspacePath('repo/../out/report.txt'), '/workspace/out/report.txt');
  assert.equal(toWorkspaceUri('/workspace/out/report.txt'), 'workspace:/workspace/out/report.txt');
  assert.throws(() => normalizeWorkspacePath('/tmp/secret'), /escapes \/workspace/);
  assert.throws(() => normalizeWorkspacePath('/workspace/../../secret'), /escapes \/workspace/);
});
