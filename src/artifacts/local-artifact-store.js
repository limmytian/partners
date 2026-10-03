import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export class LocalArtifactStore {
  constructor({ rootDir }) {
    if (!rootDir) {
      throw new TypeError('LocalArtifactStore requires rootDir');
    }
    this.rootDir = path.resolve(rootDir);
    this.backend = 'local';
    mkdirSync(this.rootDir, { recursive: true });
    this.records = new Map();
  }

  writeArtifact(input = {}) {
    const artifactId = input.id ?? `art_${randomUUID()}`;
    const jobId = input.jobId ?? 'unscoped';
    const name = sanitizeName(input.name ?? `${artifactId}.bin`);
    const content = readArtifactContent(input);
    const relativePath = path.join(jobId, artifactId, name);
    const localPath = safeJoin(this.rootDir, relativePath);
    mkdirSync(path.dirname(localPath), { recursive: true });
    writeFileSync(localPath, content);

    const record = {
      id: artifactId,
      jobId,
      kind: input.kind ?? 'file',
      name,
      contentType: input.contentType ?? 'application/octet-stream',
      sizeBytes: content.byteLength,
      sha256: createHash('sha256').update(content).digest('hex'),
      storageUri: `artifact://local/${artifactId}`,
      downloadHandle: `artifact://local/${artifactId}`,
      retentionClass: input.retentionClass ?? 'review',
      metadata: input.metadata ?? {},
      createdAt: input.createdAt ?? new Date().toISOString(),
    };

    this.records.set(artifactId, { ...record, localPath });
    return { ...record };
  }

  readArtifact(artifactId, hint = null) {
    const record = this.records.get(artifactId) ?? this.#recoverRecord(artifactId, hint);
    if (!record) {
      return null;
    }
    return {
      artifact: publicRecord(record),
      content: readFileSync(record.localPath),
    };
  }

  listArtifacts({ jobId } = {}) {
    return [...this.records.values()]
      .filter((record) => !jobId || record.jobId === jobId)
      .map(publicRecord);
  }

  deleteArtifact(artifactId, hint = null) {
    const record = this.records.get(artifactId) ?? this.#recoverRecord(artifactId, hint);
    if (!record) {
      return false;
    }
    rmSync(path.dirname(record.localPath), { recursive: true, force: true });
    this.records.delete(artifactId);
    return true;
  }

  #recoverRecord(artifactId, hint) {
    if (!hint?.jobId || !hint?.name) {
      return null;
    }
    const name = sanitizeName(hint.name);
    const localPath = safeJoin(this.rootDir, path.join(hint.jobId, artifactId, name));
    if (!existsSync(localPath)) {
      return null;
    }
    const record = { ...hint, id: artifactId, name, localPath };
    this.records.set(artifactId, record);
    return record;
  }
}

function readArtifactContent(input) {
  if (input.contentBase64) {
    return Buffer.from(input.contentBase64, 'base64');
  }
  if (input.content !== undefined) {
    return Buffer.isBuffer(input.content) ? input.content : Buffer.from(String(input.content));
  }
  if (input.localPath) {
    return readFileSync(input.localPath);
  }
  return Buffer.alloc(0);
}

function publicRecord(record) {
  const { localPath: _localPath, ...publicArtifact } = record;
  return { ...publicArtifact };
}

function sanitizeName(name) {
  return path.basename(String(name)).replaceAll(/[^A-Za-z0-9._-]/g, '_') || 'artifact.bin';
}

function safeJoin(root, relativePath) {
  const target = path.resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Artifact path escapes root: ${relativePath}`);
  }
  return target;
}
