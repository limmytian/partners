import { spawn } from 'node:child_process';
const required = ['POSTGRES_URL', 'MCP_TEST_POSTGRES_URL', 'S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'];
const missing = required.filter(key => !process.env[key]);
if (missing.length) throw new Error(`Integration environment missing: ${missing.join(', ')}`);
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('CUBESANDBOX_')));
const child = spawn(process.execPath, ['--test', '--test-reporter=tap'], { env, stdio: ['ignore','pipe','inherit'] });
let skipped = false;
let pending = '';
child.stdout.on('data', chunk => {
  process.stdout.write(chunk);
  pending += chunk;
  const lines = pending.split('\n'); pending = lines.pop();
  for (const line of lines) if (/# SKIP\b|^# skipped [1-9]/i.test(line)) skipped = true;
});
child.on('error', error => { throw error; });
child.on('exit', code => { if (skipped) console.error('Integration suite must not skip tests'); process.exitCode = code || (skipped ? 1 : 0); });
