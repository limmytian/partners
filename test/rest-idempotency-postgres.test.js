import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PostgresGatewayStore } from '../src/gateway/postgres-gateway-store.js';
import { InMemoryAgentExecutionGateway } from '../src/gateway/in-memory-agent-execution-gateway.js';
import { createAgentExecutionGatewayServer } from '../src/gateway/http-agent-execution-gateway.js';

const connectionString = process.env.MCP_TEST_POSTGRES_URL;
test('REST: two HTTP replicas with independent Postgres connections reserve one job, conflict, restart and uncertain-start replay', { skip: !connectionString }, async t => {
  const stores = [new PostgresGatewayStore({ connectionString }), new PostgresGatewayStore({ connectionString })];
  await stores[0].migrate();
  let calls = 0;
  const provider = { name: 'coordination-test', async runJob(request) {
    calls++;
    await new Promise(r => setTimeout(r, 80));
    return { id: request.id, state: 'succeeded', exitCode: 0, artifacts: [] };
  } };
  const gateways = stores.map(store => new InMemoryAgentExecutionGateway({ store, provider }));
  const apps = gateways.map(gateway => createAgentExecutionGatewayServer({ gateway, logger: {} }));
  for (const app of apps) await new Promise(r => app.listen(0, '127.0.0.1', r));
  t.after(async () => { for (const app of apps) await app.close(); for (const store of stores) await store.close(); });
  const request = { executionMode: 'ephemeral_interpreter', tenantId: 'test-' + randomUUID(), projectId: 'p', command: { argv: ['true'] }, timeoutSeconds: 5 };
  const key = 'rest-' + randomUUID();
  const submit = async (app, body = request, idempotencyKey = key) => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/v1/jobs`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const results = await Promise.all(Array.from({ length: 40 }, (_, i) => submit(apps[i % 2])));
  assert.ok(results.every(r => r.status === 202), JSON.stringify(results));
  assert.equal(new Set(results.map(r => r.body.id)).size, 1);
  assert.ok(results.every(r => JSON.stringify(r.body) === JSON.stringify(results[0].body)));
  await new Promise(r => setTimeout(r, 150)); assert.equal(calls, 1);
  assert.equal((await submit(apps[1], { ...request, command: { argv: ['false'] } })).status, 409);
  const third = new PostgresGatewayStore({ connectionString });
  const restarted = createAgentExecutionGatewayServer({ gateway: new InMemoryAgentExecutionGateway({ store: third, provider }), logger: {} });
  await new Promise(r => restarted.listen(0, '127.0.0.1', r));
  t.after(async () => { await restarted.close(); await third.close(); });
  assert.deepEqual(await submit(restarted), results[0]); assert.equal(calls, 1);
  // Simulate process death immediately after durable intent, before any job row.
  const crashKey = 'crash-' + randomUUID();
  const intent = await gateways[0].reserveJobSubmission({ idempotencyKey: crashKey, request });
  assert.equal(await stores[0].getJob(intent.record.resourceId), null);
  assert.equal((await submit(restarted, request, crashKey)).body.id, intent.record.resourceId);
  assert.equal(calls, 1);
  // Simulate provider acceptance followed by loss of the submitting process/response.
  const lostKey = 'lost-' + randomUUID();
  const lost = await gateways[0].reserveJobSubmission({ idempotencyKey: lostKey, request });
  await gateways[0].createJob({ ...request, id: lost.record.resourceId });
  assert.equal((await submit(restarted, request, lostKey)).body.id, lost.record.resourceId);
  assert.equal(calls, 2);
  // Scope filtering is executed in SQL before LIMIT/OFFSET and survives restart.
  for (const [i, tenantId] of ['a','b','a'].entries()) await stores[0].saveSnapshot({ id: randomUUID(), tenantId: request.tenantId + tenantId, projectId: 'p', createdAt: new Date(Date.now() + i).toISOString() });
  const scoped = await third.listSnapshots({ tenantIds: [request.tenantId + 'a'], projectIds: ['p'], limit: 1, offset: 1 });
  assert.equal(scoped.length, 1); assert.equal(scoped[0].tenantId, request.tenantId + 'a');
  const overview = await third.getOverview({ tenantIds: [request.tenantId], projectIds: ['p'] });
  assert.equal(overview.jobs.total, 2);
  assert.equal((await third.listJobs({ tenantIds: ['outside-' + request.tenantId] })).length, 0);
  const template = await gateways[0].createTemplate({ name: 'persistent-source', snapshotId: scoped[0].id, tenantId: scoped[0].tenantId, projectId: 'p' });
  assert.deepEqual(await third.getTemplate(template.id), template);
  assert.deepEqual(await third.listTemplates({ tenantIds: [scoped[0].tenantId], projectIds: ['p'] }), [template]);
});
