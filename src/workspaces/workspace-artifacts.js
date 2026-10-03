export const WorkspacePersistenceKind = Object.freeze({
  Ephemeral: 'ephemeral',
  Session: 'session',
  DurableArtifact: 'durable_artifact',
  SnapshotCache: 'snapshot_cache',
});

export const WorkspaceArtifactKind = Object.freeze({
  Log: 'log',
  Patch: 'patch',
  BranchRef: 'branch_ref',
  BuildOutput: 'build_output',
  DebugBundle: 'debug_bundle',
  Metadata: 'metadata',
});

export const ArtifactRetentionClass = Object.freeze({
  Transient: 'transient',
  Review: 'review',
  Release: 'release',
  Audit: 'audit',
});

export function buildRepositoryWorkspacePlan(request = {}) {
  if (!request.workspaceId && !request.jobId && !request.sessionId) {
    throw new TypeError('Workspace plan requires workspaceId, jobId, or sessionId');
  }

  const workspaceId = request.workspaceId ?? `ws_${slugify(request.sessionId ?? request.jobId)}`;
  const rootPath = normalizeWorkspacePath(request.rootPath ?? '/workspace');
  const checkoutPath = normalizeWorkspacePath(request.checkoutPath ?? `${rootPath}/repo`);
  const artifactBaseUri = trimTrailingSlash(request.artifactBaseUri ?? `artifact://${workspaceId}`);
  const persistence = request.persistence ?? {
    kind: request.sessionId ? WorkspacePersistenceKind.Session : WorkspacePersistenceKind.Ephemeral,
  };
  assertKnownValue('persistence.kind', persistence.kind, WorkspacePersistenceKind);

  const retentionClass = request.retentionClass ?? ArtifactRetentionClass.Review;
  assertKnownValue('retentionClass', retentionClass, ArtifactRetentionClass);

  return {
    workspaceId,
    jobId: request.jobId ?? null,
    sessionId: request.sessionId ?? null,
    repository: request.repository ?? null,
    rootPath,
    checkoutPath,
    rootUri: toWorkspaceUri(rootPath),
    checkoutUri: toWorkspaceUri(checkoutPath),
    persistence: {
      kind: persistence.kind,
      cleanup: persistence.cleanup ?? cleanupForPersistence(persistence.kind),
      ttlSeconds: persistence.ttlSeconds ?? null,
    },
    artifacts: {
      baseUri: artifactBaseUri,
      retentionClass,
      collect: request.collect ?? defaultArtifactCollection(),
    },
    snapshot: request.snapshot
      ? {
          ref: request.snapshot.ref,
          purpose: request.snapshot.purpose ?? 'dependency_cache',
          mutable: request.snapshot.mutable ?? false,
        }
      : null,
  };
}

export function buildArtifactManifest({ workspace, artifacts = [], publish = null, now = new Date().toISOString() }) {
  if (!workspace?.workspaceId) {
    throw new TypeError('Artifact manifest requires a workspace plan');
  }

  const retentionClass = workspace.artifacts?.retentionClass ?? ArtifactRetentionClass.Review;
  assertKnownValue('retentionClass', retentionClass, ArtifactRetentionClass);

  return {
    schemaVersion: 1,
    workspaceId: workspace.workspaceId,
    jobId: workspace.jobId ?? null,
    sessionId: workspace.sessionId ?? null,
    createdAt: now,
    retentionClass,
    artifactBaseUri: workspace.artifacts?.baseUri ?? `artifact://${workspace.workspaceId}`,
    artifacts: artifacts.map((artifact, index) => normalizeArtifact(workspace, artifact, index)),
    publish,
  };
}

export function defaultArtifactCollection() {
  return [
    { kind: WorkspaceArtifactKind.Log, path: '/workspace/.partners/logs', retentionClass: ArtifactRetentionClass.Review },
    { kind: WorkspaceArtifactKind.Patch, path: '/workspace/.partners/changes.patch', retentionClass: ArtifactRetentionClass.Review },
    { kind: WorkspaceArtifactKind.BuildOutput, path: '/workspace/.partners/outputs', retentionClass: ArtifactRetentionClass.Review },
    { kind: WorkspaceArtifactKind.Metadata, path: '/workspace/.partners/job.json', retentionClass: ArtifactRetentionClass.Audit },
  ];
}

export function toWorkspaceUri(workspacePath) {
  return `workspace:${normalizeWorkspacePath(workspacePath)}`;
}

export function normalizeWorkspacePath(workspacePath) {
  if (typeof workspacePath !== 'string' || !workspacePath.trim()) {
    throw new TypeError('Workspace path must be a non-empty string');
  }

  const withRoot = workspacePath.startsWith('/') ? workspacePath : `/workspace/${workspacePath}`;
  const parts = [];
  for (const part of withRoot.split('/')) {
    if (!part || part === '.') {
      continue;
    }
    if (part === '..') {
      parts.pop();
      continue;
    }
    parts.push(part);
  }

  const normalized = `/${parts.join('/')}`;
  if (normalized !== '/workspace' && !normalized.startsWith('/workspace/')) {
    throw new TypeError(`Workspace path escapes /workspace: ${workspacePath}`);
  }
  return normalized;
}

function normalizeArtifact(workspace, artifact, index) {
  assertKnownValue('artifact.kind', artifact.kind, WorkspaceArtifactKind);

  const workspacePath = normalizeWorkspacePath(artifact.workspacePath ?? artifact.path ?? `/workspace/${artifact.name}`);
  const retentionClass = artifact.retentionClass ?? workspace.artifacts?.retentionClass ?? ArtifactRetentionClass.Review;
  assertKnownValue('artifact.retentionClass', retentionClass, ArtifactRetentionClass);

  const name = artifact.name ?? workspacePath.split('/').at(-1);
  return {
    id: artifact.id ?? `artifact-${index + 1}`,
    kind: artifact.kind,
    name,
    workspaceUri: toWorkspaceUri(workspacePath),
    storageUri: artifact.storageUri ?? `${trimTrailingSlash(workspace.artifacts?.baseUri ?? `artifact://${workspace.workspaceId}`)}/${encodePathSegment(name)}`,
    contentType: artifact.contentType ?? contentTypeForArtifact(artifact.kind),
    sizeBytes: artifact.sizeBytes ?? null,
    checksum: artifact.checksum ?? null,
    retentionClass,
  };
}

function cleanupForPersistence(kind) {
  if (kind === WorkspacePersistenceKind.Ephemeral) {
    return 'after_job';
  }
  if (kind === WorkspacePersistenceKind.Session) {
    return 'on_session_delete_or_ttl';
  }
  return 'backend_policy';
}

function contentTypeForArtifact(kind) {
  if (kind === WorkspaceArtifactKind.Log || kind === WorkspaceArtifactKind.Patch) {
    return 'text/plain';
  }
  if (kind === WorkspaceArtifactKind.Metadata || kind === WorkspaceArtifactKind.BranchRef) {
    return 'application/json';
  }
  return 'application/octet-stream';
}

function assertKnownValue(label, value, values) {
  if (!Object.values(values).includes(value)) {
    throw new TypeError(`Unsupported ${label}: ${value}`);
  }
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}

function encodePathSegment(value) {
  return encodeURIComponent(String(value)).replaceAll('%2F', '/');
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'workspace';
}
