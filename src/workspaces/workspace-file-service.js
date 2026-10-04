import path from 'node:path';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';

import {
  assertSafeWorkspacePath,
  evaluateFileSensitivity,
  isSensitiveFile,
  redactSensitiveContent,
} from '../security/workspace-security.js';

/**
 * Lists the directory tree of a workspace path, respecting security boundaries
 * and tagging sensitive files.
 *
 * @param {string} rootPath - Absolute local path of the session workspace
 * @param {Object} [options]
 * @param {string} [options.subpath='.'] - Target relative subpath inside workspace
 * @param {number} [options.depth=3] - Maximum recursion depth
 * @param {boolean} [options.includeHidden=false] - Whether to include dotfiles (e.g. .git, .env)
 * @returns {Promise<{ path: string, entries: Array<Object> }>}
 */
export async function listWorkspaceTree(rootPath, options = {}) {
  const subpath = options.subpath ?? '.';
  const maxDepth = Number.isInteger(options.depth) ? options.depth : 3;
  const includeHidden = options.includeHidden ?? true; // Default to true so users see project dotfiles, but sensitive flags will be added

  const { resolvedPath, relativePath } = await assertSafeWorkspacePath(rootPath, subpath);

  const stats = await fs.stat(resolvedPath);
  if (!stats.isDirectory()) {
    throw Object.assign(new Error(`Path is not a directory: ${subpath}`), { statusCode: 400 });
  }

  const entries = await scanDirectory(rootPath, resolvedPath, 0, maxDepth, includeHidden);

  return {
    path: relativePath === '' ? '.' : relativePath,
    entries,
  };
}

async function scanDirectory(rootPath, currentDir, currentDepth, maxDepth, includeHidden) {
  if (currentDepth > maxDepth) {
    return [];
  }

  let dirEntries;
  try {
    dirEntries = await fs.readdir(currentDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'EACCES') {
      return [];
    }
    throw err;
  }

  const results = [];

  for (const dirent of dirEntries) {
    if (!includeHidden && dirent.name.startsWith('.')) {
      continue;
    }

    const fullPath = path.join(currentDir, dirent.name);

    // Validate path boundary & symlinks
    let safeInfo;
    try {
      safeInfo = await assertSafeWorkspacePath(rootPath, fullPath);
    } catch {
      // If escaping or unsafe symlink, skip or mark unsafe
      continue;
    }

    const relativeWorkspacePath = safeInfo.relativePath;
    const isDir = dirent.isDirectory();
    const isSymlink = dirent.isSymbolicLink();

    let size = 0;
    let mtime = null;

    try {
      const s = await fs.stat(safeInfo.resolvedPath);
      size = s.size;
      mtime = s.mtime.toISOString();
    } catch {
      // Broken link or inaccessible
    }

    const sensitivity = evaluateFileSensitivity(relativeWorkspacePath);

    const item = {
      name: dirent.name,
      path: relativeWorkspacePath,
      type: isDir ? 'directory' : (isSymlink ? 'symlink' : 'file'),
      sizeBytes: isDir ? null : size,
      modifiedAt: mtime,
      isSensitive: sensitivity.isSensitive,
      sensitivityAction: sensitivity.action,
      children: null,
    };

    if (isDir && currentDepth < maxDepth) {
      item.children = await scanDirectory(rootPath, safeInfo.resolvedPath, currentDepth + 1, maxDepth, includeHidden);
    }

    results.push(item);
  }

  // Sort directories first, then alphabetical
  results.sort((a, b) => {
    if (a.type === 'directory' && b.type !== 'directory') return -1;
    if (a.type !== 'directory' && b.type === 'directory') return 1;
    return a.name.localeCompare(b.name);
  });

  return results;
}

/**
 * Reads a single file from the workspace for real-time preview.
 *
 * @param {string} rootPath - Absolute local path of the session workspace
 * @param {string} filePath - Relative file path inside workspace
 * @param {Object} [options]
 * @param {number} [options.maxPreviewBytes=2*1024*1024] - 2MB preview limit
 * @param {boolean} [options.allowSensitiveRedact=true] - If sensitive, redact rather than throw
 * @returns {Promise<{ path: string, content: string, sizeBytes: number, isTruncated: boolean, isSensitive: boolean, redacted: boolean }>}
 */
export async function readWorkspaceFilePreview(rootPath, filePath, options = {}) {
  const maxBytes = options.maxPreviewBytes ?? 2 * 1024 * 1024;
  const allowSensitiveRedact = options.allowSensitiveRedact ?? true;
  const { resolvedPath, relativePath } = await assertSafeWorkspacePath(rootPath, filePath, { mustExist: true });

  const stats = await fs.stat(resolvedPath);
  if (stats.isDirectory()) {
    throw Object.assign(new Error(`Cannot preview directory: ${filePath}`), { statusCode: 400 });
  }

  const sensitivity = evaluateFileSensitivity(relativePath);
  if (sensitivity.isSensitive && sensitivity.action === 'block' && !allowSensitiveRedact) {
    throw Object.assign(new Error(`Access denied to sensitive file: ${filePath}`), {
      statusCode: 403,
      code: 'ERR_SENSITIVE_FILE_BLOCKED',
    });
  }

  const fd = await fs.open(resolvedPath, 'r');
  try {
    const readLength = Math.min(stats.size, maxBytes);
    const buffer = Buffer.alloc(readLength);
    await fd.read(buffer, 0, readLength, 0);

    let textContent = buffer.toString('utf8');
    let redacted = false;

    if (sensitivity.isSensitive) {
      textContent = redactSensitiveContent(textContent);
      redacted = true;
    }

    return {
      path: relativePath,
      name: path.basename(relativePath),
      content: textContent,
      sizeBytes: stats.size,
      previewBytes: readLength,
      isTruncated: stats.size > readLength,
      isSensitive: sensitivity.isSensitive,
      redacted,
      mimeType: guessMimeType(relativePath),
    };
  } finally {
    await fd.close();
  }
}

/**
 * Creates a stream for single file download.
 *
 * @param {string} rootPath - Absolute local path of the session workspace
 * @param {string} filePath - Relative file path inside workspace
 * @returns {Promise<{ stream: NodeJS.ReadableStream, filename: string, sizeBytes: number, mimeType: string }>}
 */
export async function createSingleFileDownloadStream(rootPath, filePath) {
  const { resolvedPath, relativePath } = await assertSafeWorkspacePath(rootPath, filePath, { mustExist: true });
  const stats = await fs.stat(resolvedPath);
  if (stats.isDirectory()) {
    throw Object.assign(new Error(`Path is a directory: ${filePath}`), { statusCode: 400 });
  }

  const sensitivity = evaluateFileSensitivity(relativePath);
  if (sensitivity.isSensitive) {
    throw Object.assign(new Error(`Direct download of sensitive file is restricted: ${filePath}`), {
      statusCode: 403,
      code: 'ERR_SENSITIVE_FILE_BLOCKED',
    });
  }

  const filename = path.basename(relativePath);
  const stream = createReadStream(resolvedPath);

  return {
    stream,
    filename,
    sizeBytes: stats.size,
    mimeType: guessMimeType(filename),
  };
}

/**
 * Compresses multiple workspace files or an entire folder into a streaming tar.gz archive.
 *
 * @param {string} rootPath - Absolute local path of the session workspace
 * @param {Object} options
 * @param {string[]} [options.paths] - List of relative file/dir paths to package. If empty, packs all workspace
 * @param {string} [options.archiveName] - Name of archive file
 * @returns {Promise<{ stream: NodeJS.ReadableStream, filename: string }>}
 */
export async function createArchiveDownloadStream(rootPath, options = {}) {
  const targetPaths = options.paths && options.paths.length > 0 ? options.paths : ['.'];
  const archiveName = options.archiveName ?? `workspace-export-${Date.now()}.tar.gz`;

  // Collect all files to include
  const filesToInclude = [];

  for (const relPath of targetPaths) {
    const { resolvedPath, relativePath } = await assertSafeWorkspacePath(rootPath, relPath, { mustExist: true });
    const stats = await fs.stat(resolvedPath);

    if (stats.isDirectory()) {
      await collectFilesRecursively(rootPath, resolvedPath, filesToInclude);
    } else {
      const sens = evaluateFileSensitivity(relativePath);
      if (!sens.isSensitive) {
        filesToInclude.push({
          resolvedPath,
          archiveEntryPath: relativePath,
          sizeBytes: stats.size,
          mtime: Math.floor(stats.mtimeMs / 1000),
          mode: stats.mode,
        });
      }
    }
  }

  const tarStream = createTarGzStream(filesToInclude);

  return {
    stream: tarStream,
    filename: archiveName,
    fileCount: filesToInclude.length,
  };
}

async function collectFilesRecursively(rootPath, currentDir, acc) {
  let entries;
  try {
    entries = await fs.readdir(currentDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const dirent of entries) {
    const fullPath = path.join(currentDir, dirent.name);
    try {
      const safeInfo = await assertSafeWorkspacePath(rootPath, fullPath);
      if (dirent.isDirectory()) {
        await collectFilesRecursively(rootPath, safeInfo.resolvedPath, acc);
      } else if (dirent.isFile()) {
        const sens = evaluateFileSensitivity(safeInfo.relativePath);
        if (!sens.isSensitive) {
          const stats = await fs.stat(safeInfo.resolvedPath);
          acc.push({
            resolvedPath: safeInfo.resolvedPath,
            archiveEntryPath: safeInfo.relativePath,
            sizeBytes: stats.size,
            mtime: Math.floor(stats.mtimeMs / 1000),
            mode: stats.mode,
          });
        }
      }
    } catch {
      // Ignore boundary violations / bad symlinks in recursion
    }
  }
}

/**
 * Creates a ustar tar archive header buffer (512 bytes).
 */
function createTarHeader(name, size, mode = 0o644, mtime = Math.floor(Date.now() / 1000)) {
  const buf = Buffer.alloc(512);
  // Truncate or use up to 100 bytes for standard ustar name
  const nameBuf = Buffer.from(name, 'utf8');
  if (nameBuf.length > 100) {
    nameBuf.subarray(0, 100).copy(buf, 0);
  } else {
    nameBuf.copy(buf, 0);
  }

  buf.write((mode & 0o777).toString(8).padStart(7, '0') + '\0', 100, 8, 'utf8'); // Mode
  buf.write('0000000\0', 108, 8, 'utf8'); // UID
  buf.write('0000000\0', 116, 8, 'utf8'); // GID
  buf.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'utf8'); // Size
  buf.write(mtime.toString(8).padStart(11, '0') + '\0', 136, 12, 'utf8'); // MTime
  buf.fill(0x20, 148, 156); // Checksum initial spaces
  buf.write('0', 156, 1, 'utf8'); // Type flag: regular file
  buf.write('ustar\0', 257, 6, 'utf8'); // Magic
  buf.write('00', 263, 2, 'utf8'); // Version

  // Compute checksum
  let checksum = 0;
  for (let i = 0; i < 512; i++) {
    checksum += buf[i];
  }
  buf.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf8');
  return buf;
}

/**
 * Streams tar entries piped into zlib.createGzip().
 */
function createTarGzStream(files) {
  const gzip = zlib.createGzip();

  (async () => {
    try {
      for (const file of files) {
        const header = createTarHeader(file.archiveEntryPath, file.sizeBytes, file.mode, file.mtime);
        gzip.write(header);

        // Stream file content
        const fileStream = createReadStream(file.resolvedPath);
        for await (const chunk of fileStream) {
          gzip.write(chunk);
        }

        // Padding to 512 byte boundary
        const remainder = file.sizeBytes % 512;
        if (remainder > 0) {
          const padding = Buffer.alloc(512 - remainder);
          gzip.write(padding);
        }
      }

      // End of tar: two 512-byte zero blocks
      gzip.write(Buffer.alloc(1024));
      gzip.end();
    } catch (err) {
      gzip.destroy(err);
    }
  })();

  return gzip;
}

export function guessMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html':
    case '.htm':
      return 'text/html; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.js':
    case '.mjs':
      return 'application/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.md':
      return 'text/markdown; charset=utf-8';
    case '.txt':
    case '.log':
      return 'text/plain; charset=utf-8';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.svg':
      return 'image/svg+xml';
    case '.pdf':
      return 'application/pdf';
    case '.zip':
      return 'application/zip';
    case '.tar':
      return 'application/x-tar';
    case '.gz':
      return 'application/gzip';
    default:
      return 'application/octet-stream';
  }
}

/**
 * Synchronizes a list of files and directories into a workspace root.
 * Validates path traversal boundaries and checks sensitivity policies.
 *
 * @param {string} rootPath - Absolute local path of the session workspace
 * @param {Array<{ path: string, content?: string, contentBase64?: string, mode?: number }>} files
 * @param {Object} [options]
 * @param {boolean} [options.allowSensitive=false] - Whether to allow writing sensitive files
 * @returns {Promise<{ written: Array<{ path: string, sizeBytes: number }>, count: number, totalBytes: number }>}
 */
export async function syncWorkspaceFiles(rootPath, files = [], options = {}) {
  const allowSensitive = options.allowSensitive ?? false;
  const written = [];
  let totalBytes = 0;

  for (const file of files) {
    if (!file?.path || typeof file.path !== 'string') {
      throw Object.assign(new Error('Each file must have a non-empty string "path"'), { statusCode: 400 });
    }

    const { resolvedPath, relativePath } = await assertSafeWorkspacePath(rootPath, file.path);

    const sensitivity = evaluateFileSensitivity(relativePath);
    if (sensitivity.isSensitive && sensitivity.action === 'block' && !allowSensitive) {
      throw Object.assign(new Error(`Writing sensitive file is restricted by policy: ${relativePath}`), {
        statusCode: 403,
        code: 'ERR_SENSITIVE_FILE_BLOCKED',
      });
    }

    let buf;
    if (file.contentBase64 !== undefined) {
      buf = Buffer.from(file.contentBase64, 'base64');
    } else if (file.content !== undefined) {
      buf = Buffer.from(String(file.content), 'utf8');
    } else {
      buf = Buffer.alloc(0);
    }

    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
    await fs.writeFile(resolvedPath, buf, { mode: file.mode ?? 0o644 });

    totalBytes += buf.byteLength;
    written.push({
      path: relativePath,
      sizeBytes: buf.byteLength,
    });
  }

  return {
    written,
    count: written.length,
    totalBytes,
  };
}

/**
 * Extracts a tar.gz / tar buffer into the workspace root.
 *
 * @param {string} rootPath - Absolute local path of the session workspace
 * @param {Buffer} archiveBuffer - Raw Buffer of tar or tar.gz archive
 * @param {Object} [options]
 * @param {boolean} [options.allowSensitive=false] - Whether sensitive files are allowed
 * @returns {Promise<{ written: Array<{ path: string, sizeBytes: number }>, count: number, totalBytes: number }>}
 */
export async function extractTarGzToWorkspace(rootPath, archiveBuffer, options = {}) {
  let tarBuffer;
  try {
    tarBuffer = zlib.gunzipSync(archiveBuffer);
  } catch {
    // If not gzipped, try raw tar
    tarBuffer = archiveBuffer;
  }

  const entries = parseTarArchive(tarBuffer);
  const files = [];

  for (const entry of entries) {
    if (entry.typeFlag === '5' || entry.name.endsWith('/')) {
      // Directory entry
      const { resolvedPath } = await assertSafeWorkspacePath(rootPath, entry.name);
      await fs.mkdir(resolvedPath, { recursive: true });
      continue;
    }
    files.push({
      path: entry.name,
      contentBase64: entry.data.toString('base64'),
      mode: entry.mode,
    });
  }

  return syncWorkspaceFiles(rootPath, files, options);
}

/**
 * Internal helper to parse a POSIX ustar tar archive buffer.
 */
function parseTarArchive(buffer) {
  const entries = [];
  let offset = 0;

  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    offset += 512;

    if (header.every((byte) => byte === 0)) {
      break; // End of archive
    }

    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '').trim();
    if (!name) continue;

    const modeStr = header.subarray(100, 108).toString('utf8').replace(/\0.*$/, '').trim();
    const mode = Number.parseInt(modeStr, 8) || 0o644;

    const sizeStr = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = Number.parseInt(sizeStr, 8) || 0;

    const typeFlag = String.fromCharCode(header[156]) || '0';

    if (offset + size > buffer.length) {
      throw Object.assign(new Error(`Corrupted tar entry: ${name}`), { statusCode: 400 });
    }

    const data = Buffer.from(buffer.subarray(offset, offset + size));
    offset += Math.ceil(size / 512) * 512;

    entries.push({ name, mode, size, typeFlag, data });
  }

  return entries;
}

