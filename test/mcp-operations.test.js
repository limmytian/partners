import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryGatewayStore } from '../src/gateway/gateway-store.js';
import { GatewayServiceAuthorizer } from '../src/security/gateway-service-auth.js';
import { McpOperations } from '../src/mcp/operations.js';

const headers = { authorization: 'Bearer test' };
function fixture() {
  const gateway = { store: new InMemoryGatewayStore() };
  const authorizer = new GatewayServiceAuthorizer({ tokens: [{ token: 'test', tenantIds: ['a'], projectIds: ['p'], scopes: ['jobs:create'] }] });
  return new McpOperations({ gateway, authorizer });
}
test('MCP requires authentication and verifies trusted resource scope', async () => {
  assert.throws(() => new McpOperations({ authorizer: new GatewayServiceAuthorizer() }));
  const ops = fixture();
  await ops.authorize(headers, 'jobs:create', { tenantId: 'a', projectId: 'p' });
  await assert.rejects(ops.authorize(headers, 'jobs:create', { tenantId: 'other', projectId: 'p' }), { code: 'FORBIDDEN' });
  await assert.rejects(ops.authorize(headers, 'jobs:cancel', { tenantId: 'a', projectId: 'p' }), { code: 'FORBIDDEN' });
});
test('concurrent duplicate submissions have one side effect and a stable replay', async () => {
  const ops = fixture(), second = new McpOperations({ gateway: ops.gateway, authorizer: ops.authorizer });
  let calls = 0, finish;
  const wait = new Promise(r => { finish = r; });
  const args = { requestId: 'request-1', command: 'ls' }, scope = { tenantId: 'a', projectId: 'p' };
  const first = ops.once('bash_exec', args, scope, 's', async () => { calls++; await wait; return { jobId: 'job-1' }; });
  await assert.rejects(second.once('bash_exec', args, scope, 's', () => { calls++; }), { code: 'OPERATION_PENDING' });
  finish(); await first;
  assert.deepEqual(await second.once('bash_exec', args, scope, 's', () => { calls++; }), { jobId: 'job-1' });
  assert.equal(calls, 1);
  await assert.rejects(ops.once('bash_exec', { ...args, command: 'rm' }, scope, 's', () => {}), { code: 'IDEMPOTENCY_CONFLICT' });
});
test('unknown failure remains reserved rather than repeating side effects', async () => {
  const ops = fixture(), args = { requestId: 'request-1' }, scope = { tenantId: 'a', projectId: 'p' };
  await assert.rejects(ops.once('write', args, scope, 's', () => { throw new Error('lost response'); }));
  await assert.rejects(ops.once('write', args, scope, 's', () => assert.fail('must not retry')), { code: 'OPERATION_PENDING' });
});
