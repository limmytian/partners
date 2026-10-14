import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

test('sandbox-agent timeout terminates TERM-resistant process groups', { timeout: 7000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'partners-agent-test-')), token = randomUUID();
  const child = spawn(process.execPath, ['src/sandbox-agent/server.mjs'], { env: { PATH: process.env.PATH,
    SANDBOX_AGENT_HOST: '127.0.0.1', SANDBOX_AGENT_PORT: '0', SANDBOX_AGENT_TOKEN: token, SANDBOX_WORKSPACE: root }, stdio: ['ignore','pipe','pipe'] });
  t.after(async () => { child.kill('SIGTERM'); if (child.exitCode == null) await new Promise(r => child.once('exit', r)); await rm(root, { recursive: true, force: true }); });
  const port = await new Promise((resolve, reject) => {
    let text = ''; const timer = setTimeout(() => reject(new Error('Startup deadline')), 3000);
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Agent startup failed')); });
    child.stdout.on('data', data => { text += data; for (const line of text.split('\n')) { try { const row = JSON.parse(line); if (row.message === 'sandbox agent started') { clearTimeout(timer); resolve(row.port); } } catch {} } });
  });
  const started = Date.now();
  const response = await fetch(`http://127.0.0.1:${port}/v1/exec`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ argv: ['bash','-lc','trap "" TERM; sleep 20'], cwd: '/workspace', timeoutSeconds: 1 }) });
  const result = await response.json();
  assert.equal(result.timedOut, true); assert.notEqual(result.exitCode, 0);
  assert.ok(Date.now() - started < 3500);
});
