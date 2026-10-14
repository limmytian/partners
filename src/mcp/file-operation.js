import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { mcpError } from './coordination.js';
const code = readFileSync(new URL('./workspace-file-operation.py', import.meta.url), 'utf8');
export function workspaceFileCommand(root, args) {
  const payload = Buffer.from(JSON.stringify(args));
  const chunks = [];
  for (let start = 0; start < payload.length;) {
    let end = Math.min(start + 8192, payload.length);
    while (end < payload.length && (payload[end] & 0xc0) === 0x80) end--;
    chunks.push(payload.subarray(start, end).toString('utf8')); start = end;
  }
  return ['python3', '-I', '-c', code, root, ...chunks];
}
export function parseWorkspaceResult(stdout, exitCode) {
  if (exitCode !== 0) throw mcpError(exitCode === 127 ? 'UNSUPPORTED_CAPABILITY' : 'PROVIDER_UNAVAILABLE');
  let output;
  try { output = JSON.parse(stdout); } catch { throw mcpError('PROVIDER_UNAVAILABLE'); }
  if (!output.ok) throw mcpError(output.code ?? 'PROVIDER_UNAVAILABLE');
  return output.result;
}
export async function localWorkspaceFileOperation(root, args) {
  const argv = workspaceFileCommand(root, args);
  const child = spawn(argv[0], argv.slice(1), { cwd: root, env: { PATH: process.env.PATH, LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', size = 0, tooLarge = false;
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000); timer.unref();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => { size += Buffer.byteLength(chunk); if (size > 1048576) { tooLarge = true; child.kill('SIGKILL'); } else stdout += chunk; });
  child.stderr.resume();
  try {
    const exitCode = await new Promise((resolve, reject) => { child.once('error', error => reject(error.code === 'ENOENT' ? mcpError('UNSUPPORTED_CAPABILITY') : error)); child.once('close', code => resolve(code)); });
    if (tooLarge) throw mcpError('PROVIDER_UNAVAILABLE');
    return parseWorkspaceResult(stdout, exitCode);
  } finally { clearTimeout(timer); }
}
