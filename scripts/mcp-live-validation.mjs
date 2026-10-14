#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { PostgresGatewayStore } from '../src/gateway/postgres-gateway-store.js';

const { CUBESANDBOX_ENDPOINT, CUBESANDBOX_PROXY_ENDPOINT, MCP_TEST_POSTGRES_URL } = process.env;
if (!CUBESANDBOX_ENDPOINT || !CUBESANDBOX_PROXY_ENDPOINT || !MCP_TEST_POSTGRES_URL) throw new Error('Remote API/proxy endpoints and isolated MCP_TEST_POSTGRES_URL are required');
const run = randomUUID(), tenant = `mcp-live:${run}`, token = randomUUID();
const root = await mkdtemp(path.join(tmpdir(), 'partners-mcp-live-'));
const store = new PostgresGatewayStore({ connectionString: MCP_TEST_POSTGRES_URL }); await store.migrate();
const evidence = { run, protocol: '2025-11-25', startedAt: new Date().toISOString(), cases: [], root };
const remoteIds = new Set(); const clients = []; const processes = [];
let gateway;
const delay = ms => new Promise(r => setTimeout(r, ms));
async function api(route, method = 'GET') {
  const res = await fetch(CUBESANDBOX_ENDPOINT.replace(/\/$/, '') + route, { method,
    headers: process.env.CUBESANDBOX_API_KEY ? { Authorization: `Bearer ${process.env.CUBESANDBOX_API_KEY}` } : {}, signal: AbortSignal.timeout(10000) });
  return { status: res.status, data: await res.json().catch(() => null) };
}
async function connect() {
  const client = new Client({ name: 'partners-live-validation', version: '1.0.0' }); clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(gateway.url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}
async function start() {
  const child = spawn(process.execPath, ['scripts/gateway-service.mjs'], { cwd: process.cwd(), env: {
    PATH: process.env.PATH, GATEWAY_HOST: '127.0.0.1', GATEWAY_PORT: '0', GATEWAY_PROVIDER: 'cubesandbox', GATEWAY_MCP_ENABLED: '1', GATEWAY_STORE: 'postgres',
    POSTGRES_URL: MCP_TEST_POSTGRES_URL, CUBESANDBOX_ENDPOINT, CUBESANDBOX_PROXY_ENDPOINT,
    ...(process.env.CUBESANDBOX_API_KEY ? { CUBESANDBOX_API_KEY: process.env.CUBESANDBOX_API_KEY } : {}),
    GATEWAY_SERVICE_TOKEN: token, GATEWAY_SERVICE_TOKEN_REF: `live:${run}`, GATEWAY_TENANT_IDS: tenant, GATEWAY_PROJECT_IDS: 'partners',
    GATEWAY_SERVICE_SCOPES: 'sessions:create,sessions:read,sessions:write,sessions:delete,jobs:create,jobs:read,jobs:cancel,artifacts:read',
    GATEWAY_WORK_ROOT: root, GATEWAY_ARTIFACT_ROOT: path.join(root, 'artifacts'),
  }, stdio: ['ignore', 'pipe', 'pipe'] }); processes.push(child);
  let errorLog = ''; child.stderr.on('data', data => { errorLog += data; });
  const port = await new Promise((resolve, reject) => {
    let output = ''; const timer = setTimeout(() => reject(new Error('Gateway startup deadline')), 10000);
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Gateway startup failed')); });
    child.stdout.on('data', data => { output += data; for (const line of output.split('\n')) try { const row = JSON.parse(line); if (row.message === 'gateway started') { clearTimeout(timer); resolve(row.port); } } catch {} });
  });
  gateway = { child, url: new URL(`http://127.0.0.1:${port}/mcp`), errorLog: () => errorLog };
  return connect();
}
async function stop(signal = 'SIGTERM') {
  const child = gateway.child; if (child.exitCode == null && child.signalCode == null) { child.kill(signal); await new Promise(r => child.once('exit', r)); }
}
async function call(client, name, args, expectedCode) {
  const response = await client.callTool({ name, arguments: args }); const value = response.structuredContent;
  if (expectedCode) { assert.equal(value?.code, expectedCode); return value; }
  if (response.isError && name !== 'job_get') throw Object.assign(new Error(`Tool ${name} failed: ${value?.code}`), { code: value?.code });
  assert.ok(value); return value;
}
function passed(name, data = {}) { evidence.cases.push({ name, status: 'passed', ...data }); console.log(JSON.stringify({ case: name, status: 'passed', ...data })); }
async function create(client, label, ttlSeconds) {
  const args = { tenantId: tenant, projectId: 'partners', requestId: `create:${run}:${label}`, ...(ttlSeconds ? { ttlSeconds } : {}) };
  const result = await call(client, 'session_create', args); const stored = await store.getSession(result.sessionId);
  assert.ok(stored.providerSessionId); remoteIds.add(stored.providerSessionId);
  const live = await api('/sandboxes/' + stored.providerSessionId); assert.equal(live.status, 200);
  evidence.cases.push({ name: 'created:' + label, status: 'passed', sessionId: result.sessionId, remoteId: stored.providerSessionId, node: live.data?.clientID });
  return { ...result, remoteId: stored.providerSessionId, args };
}
async function exec(client, session, command, label, timeoutSeconds = 30) {
  const args = { sessionId: session.sessionId, command, requestId: `exec:${run}:${label}`, timeoutSeconds };
  const accepted = await call(client, 'bash_exec', args); return { ...accepted, args };
}
async function poll(client, job, expectedState = 'succeeded', maxMs = 20000) {
  const deadline = Date.now() + maxMs; let result;
  do {
    result = await call(client, 'job_get', { jobId: job.jobId });
    if (['succeeded','failed','timed_out','cancelled'].includes(result.state)) break;
    await delay(100);
  } while (Date.now() < deadline);
  assert.equal(result.state, expectedState, JSON.stringify(result)); return result;
}
const baseline = await api('/sandboxes'); assert.equal(baseline.status, 200);
const baselineIds = new Set(baseline.data.map(s => s.sandboxID));
try {
  let client = await start(); assert.equal((await client.listTools()).tools.length, 7);
  const idle = await create(client, 'idle', 60);
  const session = await create(client, 'happy');
  assert.equal((await call(client, 'session_create', session.args)).sessionId, session.sessionId);
  const dir = 'mcp-live-' + run;
  const write = { sessionId: session.sessionId, action: 'write', path: dir + '/hello.py', content: "print('live-mcp-你好')", createOnly: true, requestId: `write:${run}:hello` };
  const written = await call(client, 'file_ops', write);
  assert.equal((await call(client, 'file_ops', write)).hash, written.hash);
  await call(client, 'file_ops', { ...write, requestId: `write:${run}:conflict` }, 'WRITE_CONFLICT');
  const job = await exec(client, session, `uname -r; pwd; python3 ${dir}/hello.py`, 'kernel');
  await client.close(); client = await connect();
  const completed = await poll(client, job);
  assert.match(completed.stdout, /live-mcp-你好/); assert.match(completed.stdout, /^6\.6\./m); assert.match(completed.stdout, /\/workspace/);
  evidence.kernelOutput = completed.stdout.trim(); passed('file-exec-reconnect-idempotency', { kernelOutput: completed.stdout.trim() });
  const read = await call(client, 'file_ops', { sessionId: session.sessionId, action: 'read', path: dir + '/hello.py' }); assert.equal(read.hash, written.hash);
  await call(client, 'file_ops', { ...write, expectedHash: read.hash, createOnly: false, content: "print('updated')", requestId: `write:${run}:update` });
  await poll(client, await exec(client, session, `printf harmless > ${dir}/.env; ln -s /etc ${dir}/escape`, 'security'));
  await call(client, 'file_ops', { sessionId: session.sessionId, action: 'read', path: dir + '/.env' }, 'FORBIDDEN');
  await call(client, 'file_ops', { sessionId: session.sessionId, action: 'read', path: dir + '/escape/passwd' }, 'INVALID_ARGUMENT');
  const listed = await call(client, 'file_ops', { sessionId: session.sessionId, action: 'list', path: dir }); assert.deepEqual(listed.entries.map(e => e.path), ['hello.py']);
  passed('sandbox-file-boundaries-and-conditional-write');
  const large = await exec(client, session, `python3 -c "print('你好世界'*5000)"`, 'unicode'); await poll(client, large);
  let cursor, text = '', page;
  do { page = await call(client, 'job_get', { jobId: large.jobId, maxOutputBytes: 1024, ...(cursor ? { cursor } : {}) }); text += page.stdout; assert.ok(Buffer.byteLength(page.stdout + page.stderr) <= 1024); cursor = page.nextCursor; } while (page.truncated);
  assert.ok(text === '你好世界'.repeat(5000) + '\n', `Unicode output mismatch: actualBytes=${Buffer.byteLength(text)}, expectedBytes=60001, replacementCount=${(text.match(/�/g) ?? []).length}`); passed('unicode-output-pagination', { bytes: Buffer.byteLength(text) });
  const failed = await poll(client, await exec(client, session, 'printf live-stderr >&2; exit 7', 'failure'), 'failed'); assert.equal(failed.exitCode, 7); assert.match(failed.stderr, /live-stderr/);
  assert.ok(failed.artifactRefs.some(a => a.kind === 'stderr'), 'stderr must be retained as an artifact');
  const stdoutArtifact = completed.artifactRefs.find(a => a.kind === 'stdout'); assert.ok(stdoutArtifact);
  const download = await fetch(new URL(stdoutArtifact.downloadPath, gateway.url), { headers: { Authorization: `Bearer ${token}` } }); assert.equal(download.status, 200); assert.match(await download.text(), /live-mcp-你好/);
  passed('nonzero-exit-and-durable-artifacts');
  const cancelSession = await create(client, 'cancel'); const cancelJob = await exec(client, cancelSession, 'sleep 120', 'cancel', 180); await delay(300);
  await call(client, 'job_cancel', { jobId: cancelJob.jobId }); await poll(client, cancelJob, 'cancelled');
  assert.equal((await call(client, 'session_get', { sessionId: cancelSession.sessionId })).state, 'deleted'); assert.equal((await api('/sandboxes/' + cancelSession.remoteId)).status, 404); passed('cancel-confirmed-runtime-fence');
  const timeoutSession = await create(client, 'timeout'); const timeoutJob = await exec(client, timeoutSession, 'sleep 120', 'timeout', 1);
  await poll(client, timeoutJob, 'timed_out'); assert.equal((await api('/sandboxes/' + timeoutSession.remoteId)).status, 404); passed('timeout-confirmed-runtime-fence');
  await client.close(); await stop(); client = await start();
  assert.equal((await poll(client, job)).stdout, completed.stdout);
  assert.equal((await call(client, 'bash_exec', job.args)).jobId, job.jobId);
  assert.equal((await call(client, 'file_ops', { sessionId: session.sessionId, action: 'read', path: dir + '/hello.py' })).content, "print('updated')"); passed('completed-job-and-workspace-survive-gateway-restart');
  const orphanSession = await create(client, 'crash'); const orphanJob = await exec(client, orphanSession, 'printf worker-started; sleep 120', 'crash', 180);
  let observed;
  for (let n = 0; n < 100; n++) { observed = await call(client, 'job_get', { jobId: orphanJob.jobId }); if (observed.stdout.includes('worker-started')) break; await delay(100); }
  assert.match(observed.stdout, /worker-started/);
  await stop('SIGKILL'); await client.close(); client = await start();
  console.log(JSON.stringify({ stage: 'waiting-for-real-lease-expiry', seconds: 48 })); await delay(48000);
  const unknown = await poll(client, orphanJob, 'failed'); assert.equal(unknown.terminalReason, 'EXECUTION_UNKNOWN');
  await call(client, 'bash_exec', { sessionId: orphanSession.sessionId, command: 'true', requestId: `exec:${run}:forbidden-retry` }, 'RECOVERY_REQUIRED');
  await call(client, 'session_delete', { sessionId: orphanSession.sessionId }); assert.equal((await api('/sandboxes/' + orphanSession.remoteId)).status, 404); passed('killed-worker-unknown-execution-and-fence');
  for (let n = 0; n < 20 && (await call(client, 'session_get', { sessionId: idle.sessionId })).state !== 'deleted'; n++) await delay(1000);
  assert.equal((await call(client, 'session_get', { sessionId: idle.sessionId })).state, 'deleted'); assert.equal((await api('/sandboxes/' + idle.remoteId)).status, 404); passed('real-idle-ttl-reclamation');
  await call(client, 'session_delete', { sessionId: session.sessionId });
  evidence.status = 'passed';
} catch (error) {
  evidence.status = 'failed'; evidence.error = { message: error.message, code: error.code };
  process.exitCode = 1; console.error(JSON.stringify({ stage: 'validation-failed', ...evidence.error }));
} finally {
  for (const client of clients) await client.close().catch(() => {});
  for (const child of processes) if (child.exitCode == null && child.signalCode == null) { child.kill('SIGTERM'); await new Promise(r => child.once('exit', r)); }
  // Only resources allocated to this unique run are eligible for cleanup.
  for (const session of await store.listSessions({ tenantId: tenant, limit: 1000 })) if (session.providerSessionId) remoteIds.add(session.providerSessionId);
  for (const id of remoteIds) { assert.equal(baselineIds.has(id), false); const live = await api('/sandboxes/' + id); if (live.status !== 404) await api('/sandboxes/' + id, 'DELETE'); }
  const remaining = await api('/sandboxes'); evidence.remainingOwnSandboxes = remaining.data.filter(s => remoteIds.has(s.sandboxID)).length;
  assert.equal(evidence.remainingOwnSandboxes, 0); evidence.completedAt = new Date().toISOString();
  await writeFile(path.join(root, 'evidence.json'), JSON.stringify(evidence, null, 2)); await store.close();
  console.log(JSON.stringify({ status: evidence.status, evidencePath: path.join(root, 'evidence.json'), remainingOwnSandboxes: evidence.remainingOwnSandboxes }));
}
