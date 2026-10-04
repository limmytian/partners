import path from 'node:path';
import fs from 'node:fs/promises';

/**
 * Default patterns for sensitive files that should be blocked or redacted
 * from direct preview/download within workspace sessions.
 */
export const DEFAULT_SENSITIVE_PATTERNS = Object.freeze([
  // Environment variables and secrets
  /^\.env(\..+)?$/i,
  /^\.secrets?(\..+)?$/i,
  // Private keys and certificates
  /\.(pem|key|pkcs12|pfx|p12)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  // Cloud & service credentials
  /^\.?aws\/(credentials|config)$/i,
  /^\.?kube\/config$/i,
  /^\.?docker\/config\.json$/i,
  // Package manager tokens
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.netrc$/i,
  // Git credentials / config with potential secrets
  /^\.git-credentials$/i,
  /^\.gitconfig$/i,
  // History files with potential credentials
  /^\.(bash_history|zsh_history|sh_history|python_history)$/i,
]);

/**
 * Exact filenames that represent sensitive credentials.
 */
export const DEFAULT_SENSITIVE_FILENAMES = Object.freeze([
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  '.env.test',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.git-credentials',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
]);

/**
 * Checks if a relative or normalized workspace path corresponds to a sensitive file.
 *
 * @param {string} workspacePath - Workspace path (e.g. "repo/.env" or "/workspace/.env")
 * @param {Object} [options]
 * @param {RegExp[]} [options.patterns]
 * @param {string[]} [options.filenames]
 * @returns {boolean}
 */
export function isSensitiveFile(workspacePath, options = {}) {
  if (typeof workspacePath !== 'string' || !workspacePath.trim()) {
    return false;
  }

  // Clean path to get basename and relative path
  const normalized = workspacePath.replace(/^\/workspace\/?/, '').replace(/^\/+/, '');
  const basename = path.basename(normalized);
  const patterns = options.patterns ?? DEFAULT_SENSITIVE_PATTERNS;
  const filenames = options.filenames ?? DEFAULT_SENSITIVE_FILENAMES;

  if (filenames.includes(basename) || filenames.includes(normalized)) {
    return true;
  }

  for (const pattern of patterns) {
    if (pattern.test(basename) || pattern.test(normalized)) {
      return true;
    }
  }

  return false;
}

/**
 * Options and policy for assessing sensitivity.
 *
 * @param {string} workspacePath
 * @param {Object} [policy]
 * @returns {{ isSensitive: boolean, reason: string | null, action: 'allow' | 'block' | 'redact' }}
 */
export function evaluateFileSensitivity(workspacePath, policy = {}) {
  const sensitive = isSensitiveFile(workspacePath, policy);
  if (!sensitive) {
    return { isSensitive: false, reason: null, action: 'allow' };
  }

  const defaultAction = policy.action ?? 'block';
  return {
    isSensitive: true,
    reason: `File '${path.basename(workspacePath)}' matches sensitive file security policy`,
    action: defaultAction,
  };
}

/**
 * Redacts known sensitive token/key patterns from string or buffer contents.
 *
 * @param {string|Buffer} content
 * @returns {string}
 */
export function redactSensitiveContent(content) {
  const text = typeof content === 'string' ? content : content.toString('utf8');
  return text
    // Generic API keys, private keys, secrets
    .replace(/(-----BEGIN [A-Z0-9_-]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9_-]+ PRIVATE KEY-----)/g, '[REDACTED PRIVATE KEY]')
    .replace(/(:\/\/[^:\/\s]+:)([^@\/\s]+)(@)/g, '$1[REDACTED]$3')
    .replace(/((?:api[_-]?key|secret|password|passwd|token|bearer|credential|auth)\s*[:=]\s*["']?)([^"'\r\n\s]+)(["']?)/gi, (match, prefix, val, suffix) => {
      if (val.startsWith('[REDACTED')) {
        return match;
      }
      if (/^(ghp_[a-zA-Z0-9]{36}|github_pat_[a-zA-Z0-9_]{82})$/.test(val)) {
        return `${prefix}[REDACTED GITHUB TOKEN]${suffix}`;
      }
      if (/^xox[baprs]-[0-9a-zA-Z]{10,48}$/.test(val)) {
        return `${prefix}[REDACTED SLACK TOKEN]${suffix}`;
      }
      if (/^AKIA[0-9A-Z]{16}$/.test(val)) {
        return `${prefix}[REDACTED AWS KEY]${suffix}`;
      }
      return `${prefix}[REDACTED]${suffix}`;
    })
    .replace(/(ghp_[a-zA-Z0-9]{36}|github_pat_[a-zA-Z0-9_]{82})/g, '[REDACTED GITHUB TOKEN]')
    .replace(/(xox[baprs]-[0-9a-zA-Z]{10,48})/g, '[REDACTED SLACK TOKEN]')
    .replace(/(AKIA[0-9A-Z]{16})/g, '[REDACTED AWS KEY]');
}

/**
 * Resolves and validates a path within a workspace root, verifying canonical boundaries
 * and preventing Path Traversal & Symlink escapes.
 *
 * @param {string} rootPath - Workspace base directory (e.g. /workspace or local temp dir)
 * @param {string} targetPath - Relative or absolute path inside the workspace
 * @param {Object} [options]
 * @param {boolean} [options.allowSymlinkEscape=false] - If false, resolved symlinks outside root are rejected
 * @param {boolean} [options.mustExist=false] - If true, throws if file does not exist
 * @param {boolean} [options.checkSymlinks=true] - If true, checks symlink targets
 * @returns {Promise<{ resolvedPath: string, relativePath: string }>}
 */
export async function assertSafeWorkspacePath(rootPath, targetPath, options = {}) {
  if (typeof rootPath !== 'string' || !rootPath.trim()) {
    throw new TypeError('rootPath must be a non-empty string');
  }
  if (typeof targetPath !== 'string' || !targetPath.trim()) {
    throw new TypeError('targetPath must be a non-empty string');
  }

  // 1. Resolve root path canonically
  let canonicalRoot;
  try {
    canonicalRoot = await fs.realpath(rootPath);
  } catch (err) {
    if (err.code === 'ENOENT') {
      canonicalRoot = path.resolve(rootPath);
    } else {
      throw err;
    }
  }

  // 2. Lexical path normalization
  // If target starts with /workspace, strip it if rootPath is not /workspace, or handle properly
  let relativePart = targetPath;
  if (relativePart.startsWith('/workspace/')) {
    relativePart = relativePart.slice('/workspace/'.length);
  } else if (relativePart === '/workspace') {
    relativePart = '.';
  } else if (path.isAbsolute(relativePart)) {
    // If targetPath is already within canonicalRoot, get relative
    if (relativePart.startsWith(canonicalRoot + path.sep)) {
      relativePart = path.relative(canonicalRoot, relativePart);
    } else if (relativePart === canonicalRoot) {
      relativePart = '.';
    } else {
      // Stripping leading slash if treated as relative to workspace
      relativePart = relativePart.replace(/^\/+/, '');
    }
  }

  const resolved = path.resolve(canonicalRoot, relativePart);

  // 3. Lexical boundary check
  if (resolved !== canonicalRoot && !resolved.startsWith(canonicalRoot + path.sep)) {
    const error = new Error(`Path escapes workspace boundary: ${targetPath}`);
    error.code = 'ERR_WORKSPACE_PATH_ESCAPE';
    error.statusCode = 400;
    throw error;
  }

  // 4. Canonical / Symlink boundary check
  const checkSymlinks = options.checkSymlinks ?? true;
  if (checkSymlinks) {
    let current = resolved;
    let exists = true;
    try {
      const stats = await fs.lstat(current);
      if (stats.isSymbolicLink()) {
        const real = await fs.realpath(current);
        if (real !== canonicalRoot && !real.startsWith(canonicalRoot + path.sep)) {
          const error = new Error(`Symlink target escapes workspace boundary: ${targetPath} -> ${real}`);
          error.code = 'ERR_WORKSPACE_SYMLINK_ESCAPE';
          error.statusCode = 400;
          throw error;
        }
      } else {
        // Also ensure realpath of regular file/dir doesn't escape (e.g. if parent dir was a symlink)
        const real = await fs.realpath(current);
        if (real !== canonicalRoot && !real.startsWith(canonicalRoot + path.sep)) {
          const error = new Error(`Canonical path escapes workspace boundary: ${targetPath} -> ${real}`);
          error.code = 'ERR_WORKSPACE_SYMLINK_ESCAPE';
          error.statusCode = 400;
          throw error;
        }
      }
    } catch (err) {
      if (err.code === 'ENOENT') {
        exists = false;
        if (options.mustExist) {
          const error = new Error(`File not found: ${targetPath}`);
          error.code = 'ENOENT';
          error.statusCode = 404;
          throw error;
        }
        // If file doesn't exist, check existing ancestors for symlink escapes
        let ancestor = path.dirname(current);
        while (ancestor.startsWith(canonicalRoot)) {
          try {
            const realAncestor = await fs.realpath(ancestor);
            if (realAncestor !== canonicalRoot && !realAncestor.startsWith(canonicalRoot + path.sep)) {
              const error = new Error(`Ancestor symlink escapes workspace boundary: ${targetPath} -> ${realAncestor}`);
              error.code = 'ERR_WORKSPACE_SYMLINK_ESCAPE';
              error.statusCode = 400;
              throw error;
            }
            break;
          } catch (ancestorErr) {
            if (ancestorErr.code === 'ENOENT') {
              ancestor = path.dirname(ancestor);
              continue;
            }
            throw ancestorErr;
          }
        }
      } else {
        throw err;
      }
    }
  }

  const relative = path.relative(canonicalRoot, resolved);
  const normalizedRelative = relative === '' ? '.' : relative.split(path.sep).join('/');

  return {
    resolvedPath: resolved,
    relativePath: normalizedRelative,
  };
}

/**
 * Synchronous lexical safe workspace path helper for fast checks.
 *
 * @param {string} rootPath
 * @param {string} targetPath
 * @returns {string}
 */
export function assertSafeWorkspacePathSync(rootPath, targetPath) {
  const normalizedRoot = path.resolve(rootPath);
  let relativePart = String(targetPath ?? '.');
  if (relativePart.startsWith('/workspace/')) {
    relativePart = relativePart.slice('/workspace/'.length);
  } else if (relativePart === '/workspace') {
    relativePart = '.';
  } else if (path.isAbsolute(relativePart)) {
    if (relativePart.startsWith(normalizedRoot + path.sep)) {
      relativePart = path.relative(normalizedRoot, relativePart);
    } else if (relativePart === normalizedRoot) {
      relativePart = '.';
    } else {
      relativePart = relativePart.replace(/^\/+/, '');
    }
  }

  const resolved = path.resolve(normalizedRoot, relativePart);
  if (resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot + path.sep)) {
    const error = new Error(`Path escapes workspace boundary: ${targetPath}`);
    error.code = 'ERR_WORKSPACE_PATH_ESCAPE';
    error.statusCode = 400;
    throw error;
  }
  return resolved;
}
