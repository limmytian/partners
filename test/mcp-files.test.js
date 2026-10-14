import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { localWorkspaceFileOperation } from '../src/mcp/file-operation.js';
import { parseMcpArguments } from '../src/mcp/contract.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'partners-file-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const call = a => localWorkspaceFileOperation(root, parseMcpArguments('file_ops', { sessionId: 's', ...a }));
  return { root, call };
}
test('conditional writes, bounded UTF-8 reads, and directory paging retain content', async t => {
  const { root, call } = await fixture(t);
  await call({ action: 'write', path: 'hello.txt', content: '你好世界', requestId: 'write-001', createOnly: true });
  const preview = await call({ action: 'read', path: 'hello.txt', maxBytes: 4 });
  assert.equal(preview.content, '你'); assert.equal(preview.nextOffsetBytes, 3); assert.equal(preview.truncated, true);
  const next = await call({ action: 'read', path: 'hello.txt', offsetBytes: preview.nextOffsetBytes, maxBytes: 4 });
  assert.equal(next.content, '好');
  await assert.rejects(call({ action: 'write', path: 'hello.txt', content: 'bad', requestId: 'write-002', createOnly: true }), { code: 'WRITE_CONFLICT' });
  await assert.rejects(call({ action: 'write', path: 'hello.txt', content: 'bad', requestId: 'write-003', expectedHash: '0'.repeat(64) }), { code: 'WRITE_CONFLICT' });
  await call({ action: 'write', path: 'hello.txt', content: 'updated', requestId: 'write-004', expectedHash: preview.hash });
  assert.equal(await readFile(path.join(root, 'hello.txt'), 'utf8'), 'updated');
  await mkdir(path.join(root, 'a')); await writeFile(path.join(root, 'a/x'), 'x'); await writeFile(path.join(root, 'a.txt'), 'y');
  const paths = []; let cursor;
  do { const page = await call({ action: 'list', path: '.', limit: 1, ...(cursor ? { cursor } : {}) }); paths.push(...page.entries.map(e => e.path)); cursor = page.nextCursor; } while (cursor);
  assert.deepEqual(paths, ['a', 'a/x', 'a.txt', 'hello.txt']);
});
test('sensitive paths, symlinks, binary files and overwrite races are rejected', async t => {
  const { root, call } = await fixture(t);
  await writeFile(path.join(root, '.env'), 'TOKEN=secret');
  await assert.rejects(call({ action: 'read', path: '.env' }), { code: 'FORBIDDEN' });
  await symlink('/etc', path.join(root, 'outside'));
  await assert.rejects(call({ action: 'read', path: 'outside/passwd' }), { code: 'INVALID_ARGUMENT' });
  await symlink('/etc/passwd', path.join(root, 'file-link'));
  await assert.rejects(call({ action: 'read', path: 'file-link' }), { code: 'INVALID_ARGUMENT' });
  await writeFile(path.join(root, 'binary'), Buffer.from([0, 1, 2]));
  await assert.rejects(call({ action: 'read', path: 'binary' }), { code: 'BINARY_UNSUPPORTED' });
  const list = await call({ action: 'list', path: '.' }); assert.equal(list.entries.some(e => ['.env', 'file-link', 'outside'].includes(e.path)), false);
  const results = await Promise.allSettled([1, 2].map(n => call({ action: 'write', path: 'new', content: String(n), requestId: `request-${n}`, createOnly: true })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
});
test('maximum single-file write avoids operating system per-argument limits', async t => {
  const { call } = await fixture(t);
  const result = await call({ action: 'write', path: 'large', content: 'x'.repeat(262144), requestId: 'write-big', createOnly: true });
  assert.equal(result.sizeBytes, 262144);
});

test('untrusted workspace modules cannot hijack fixed file helper imports', async t => {
  const { root, call } = await fixture(t);
  await writeFile(path.join(root, 'json.py'), "raise RuntimeError('workspace import executed')");
  const result = await call({ action: 'write', path: 'safe', content: 'ok', createOnly: true, requestId: 'write-safe' });
  assert.equal(result.sizeBytes, 2);
});

test('splitting large command arguments preserves multi-byte Unicode exactly', async t => {
  const { root, call } = await fixture(t);
  const content = '😀你好'.repeat(20000);
  await call({ action: 'write', path: 'unicode', content, requestId: 'write-utf8', createOnly: true });
  assert.equal(await readFile(path.join(root, 'unicode'), 'utf8'), content);
});
