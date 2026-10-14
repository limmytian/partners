import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { PostgresGatewayStore } from '../src/gateway/postgres-gateway-store.js';
import { McpPostgresCoordinator } from '../src/mcp/coordination.js';

const connectionString = process.env.MCP_TEST_POSTGRES_URL;
test('independent Postgres connections reserve one operation and survive coordinator restart', { skip: !connectionString }, async t => {
  const first = new PostgresGatewayStore({ connectionString }), second = new PostgresGatewayStore({ connectionString });
  t.after(async () => { await first.close(); await second.close(); });
  const a = new McpPostgresCoordinator(first), b = new McpPostgresCoordinator(second);
  await a.migrate();
  const key = 'test:' + randomUUID();
  const claims = await Promise.all(Array.from({ length: 40 }, (_, i) => (i % 2 ? a : b).claim(key, 'hash', { state: 'pending', resourceId: 'job-known' })));
  assert.equal(claims.filter(c => c.acquired).length, 1);
  const owner = claims.find(c => c.acquired).record.owner;
  await a.update(key, owner, { owner, requestHash: 'hash', state: 'done', response: { jobId: 'job-known' } });
  assert.deepEqual((await new McpPostgresCoordinator(second).get(key)).response, { jobId: 'job-known' });
  await b.release(key, 'different-owner'); assert.ok(await a.get(key));
  await a.release(key, owner); assert.equal(await b.get(key), null);
});

test('two Gateway replicas replay one actual job through persistent operation state', { skip: !connectionString }, async t => {
  const { fixture } = await import('./helpers/mcp-fixture.js');
  const { InMemoryAgentExecutionGateway } = await import('../src/gateway/in-memory-agent-execution-gateway.js');
  const { SandboxMcpService } = await import('../src/mcp/service.js');
  const first = new PostgresGatewayStore({ connectionString }), second = new PostgresGatewayStore({ connectionString });
  await first.migrate();
  const f = await fixture(t, { gateway: { store: first } });
  const gateway2 = new InMemoryAgentExecutionGateway({ store: second, provider: f.gateway.provider });
  const replica = new SandboxMcpService({ gateway: gateway2, authorizer: f.authorizer }); await replica.initialize();
  t.after(async () => { await replica.close(); await first.close(); await second.close(); });
  const headers = { authorization: 'Bearer full' };
  const session = await f.service.call('session_create', { tenantId: 't', projectId: 'p', requestId: 'create-' + randomUUID() }, headers);
  let calls = 0; const run = f.gateway.provider.runJob.bind(f.gateway.provider);
  f.gateway.provider.runJob = (...args) => { calls++; return run(...args); };
  const input = { sessionId: session.sessionId, command: 'printf once', requestId: 'exec-' + randomUUID() };
  const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => (i % 2 ? replica : f.service).call('bash_exec', input, headers)));
  const accepted = results.find(r => r.status === 'fulfilled').value;
  const completion = f.service.running.get(accepted.jobId) ?? replica.running.get(accepted.jobId);
  await completion;
  assert.equal(calls, 1);
  const replay = await new SandboxMcpService({ gateway: gateway2, authorizer: f.authorizer }).call('bash_exec', input, headers);
  assert.equal(replay.jobId, accepted.jobId);
  await f.service.call('session_delete', { sessionId: session.sessionId }, headers);
});
