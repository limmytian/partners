import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PostgresGatewayStore } from '../src/gateway/postgres-gateway-store.js';
import { startLiveGateway, requireLiveEnvironment } from './lib/live-gateway.mjs';
requireLiveEnvironment();
const run = randomUUID(), tenant = 'rest-live:' + run, token = randomUUID();
const root = await mkdtemp(path.join(tmpdir(), 'partners-rest-live-'));
const evidence = { run, startedAt: new Date().toISOString(), gatewayProcesses: 2, requests: 40, artifactBackend: process.env.S3_ENDPOINT ? 's3' : 'local' };
const gateways = [];
const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'idempotency-key': run };
const body = { executionMode: 'ephemeral_interpreter', tenantId: tenant, projectId: 'partners',
  artifactPolicy: { collect: ['stdout','stderr'] }, command: { argv: ['bash','-lc', "printf 'rest-real-你好\\n'; sleep 0.5; printf 'done\\n'"] }, timeoutSeconds: 30 };
const submit = async (g, input = body) => {
  const r = await fetch(g.url + '/v1/jobs', { method: 'POST', headers, body: JSON.stringify(input) });
  return { status: r.status, body: await r.json() };
};
try {
  gateways.push(await startLiveGateway({ root, tenant, token }), await startLiveGateway({ root, tenant, token }));
  evidence.gatewayPids = gateways.map(g => g.child.pid);
  const responses = await Promise.all(Array.from({ length: 40 }, (_, i) => submit(gateways[i % 2])));
  assert.ok(responses.every(r => r.status === 202), JSON.stringify(responses));
  assert.equal(new Set(responses.map(r => r.body.id)).size, 1);
  const jobId = evidence.jobId = responses[0].body.id;
  let job;
  for (let i = 0; i < 300; i++) {
    job = await (await fetch(gateways[0].url + '/v1/jobs/' + jobId, { headers })).json();
    if (['succeeded','failed','timed_out'].includes(job.state)) break;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.equal(job.state, 'succeeded', JSON.stringify(job));
  let starts = 0;
  for (const g of gateways) {
    const metrics = await (await fetch(g.url + '/metrics')).text();
    for (const line of metrics.split('\n')) if (line.startsWith('partners_gateway_jobs_started_total{')) starts += Number(line.split(' ').at(-1));
  }
  assert.equal(starts, 1); evidence.providerStarts = starts;
  assert.equal((await submit(gateways[1], { ...body, command: { argv: ['false'] } })).status, 409);
  await new Promise(r => setTimeout(r, 200));
  const artifacts = await (await fetch(gateways[0].url + '/v1/jobs/' + jobId + '/artifacts', { headers })).json();
  const artifact = (Array.isArray(artifacts) ? artifacts : artifacts.items).find(a => a.kind === 'stdout'); assert.ok(artifact);
  const download = await fetch(gateways[0].url + '/v1/artifacts/' + artifact.id + '/download', { headers });
  assert.equal(download.status, 200); assert.match(await download.text(), /rest-real-你好/);
  evidence.artifact = { id: artifact.id, storageUri: artifact.storageUri, downloadStatus: download.status };
  await gateways[0].stop(); await gateways[1].stop();
  const restarted = await startLiveGateway({ root, tenant, token }); gateways.push(restarted);
  assert.deepEqual(await submit(restarted), responses[0]);
  assert.equal((await (await fetch(restarted.url + '/v1/jobs/' + jobId, { headers })).json()).state, 'succeeded');
  const store = new PostgresGatewayStore({ connectionString: process.env.MCP_TEST_POSTGRES_URL });
  try {
    evidence.isolation = [];
    for (const [tenantId, projectId] of [[tenant + '-other', 'partners'], [tenant, 'other-project']]) {
      // Insert ownership fixtures in the isolated Gateway DB. The remote
      // Provider does not implement snapshot creation in this adapter.
      const snapshot = await store.saveSnapshot({
        id: 'snapshot-' + randomUUID(), sessionId: 'fixture-' + run, tenantId, projectId, createdAt: new Date().toISOString(),
      });
      const template = await store.saveTemplate({
        id: 'template-' + randomUUID(), snapshotId: snapshot.id, tenantId, projectId, createdAt: new Date().toISOString(),
      });
      const snapshotGet = await fetch(restarted.url + '/v1/snapshots/' + snapshot.id, { headers });
      const templateGet = await fetch(restarted.url + '/v1/templates/' + template.id, { headers });
      const restore = await fetch(restarted.url + '/v1/sessions', {
        method: 'POST', headers, body: JSON.stringify({ templateId: template.id, tenantId: tenant, projectId: 'partners' }),
      });
      assert.deepEqual([snapshotGet.status, templateGet.status, restore.status], [403, 403, 403]);
      evidence.isolation.push({ boundary: tenantId === tenant ? 'project' : 'tenant', snapshotGet: snapshotGet.status, templateGet: templateGet.status, restore: restore.status });
    }
    assert.equal((await store.listSessions({ tenantId: tenant })).length, 0, 'foreign restore created a workspace');
  } finally {
    await store.close();
  }
  evidence.status = 'passed';
} catch (error) { evidence.status = 'failed'; evidence.error = error.message; process.exitCode = 1; }
finally {
  for (const g of gateways) await g.stop();
  evidence.completedAt = new Date().toISOString(); await writeFile(path.join(root, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ ...evidence, evidencePath: path.join(root, 'evidence.json') }));
}
