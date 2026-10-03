import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GatewayServiceAuthorizer,
  hashGatewayServiceToken,
} from '../src/index.js';

test('validates service token scope, expiry, and tenant/project bounds', async () => {
  const authorizer = new GatewayServiceAuthorizer({
    clock: () => new Date('2026-07-05T00:00:00.000Z'),
    tokens: [{
      token: 'secret-token',
      tokenRef: 'tok_live_1',
      actor: 'task-weaver',
      scopes: ['jobs:create'],
      tenantIds: ['tenant_1'],
      projectIds: ['project_1'],
      expiresAt: '2026-07-06T00:00:00.000Z',
    }],
  });

  const auth = await authorizer.authorize({
    headers: { authorization: 'Bearer secret-token' },
    scope: 'jobs:create',
    tenantId: 'tenant_1',
    projectId: 'project_1',
  });

  assert.equal(auth.tokenRef, 'tok_live_1');
  assert.equal(auth.actor, 'task-weaver');
  await assert.rejects(() => authorizer.authorize({
    headers: { authorization: 'Bearer secret-token' },
    scope: 'jobs:cancel',
    tenantId: 'tenant_1',
    projectId: 'project_1',
  }), /Missing required scope/);
  await assert.rejects(() => authorizer.authorize({
    headers: { authorization: 'Bearer secret-token' },
    scope: 'jobs:create',
    tenantId: 'tenant_2',
    projectId: 'project_1',
  }), /Tenant is outside token scope/);
});

test('does not include raw tokens in authorization errors', async () => {
  const authorizer = new GatewayServiceAuthorizer({
    tokens: [{ token: 'correct-token', scopes: ['*'] }],
  });

  await assert.rejects(() => authorizer.authorize({
    headers: { authorization: 'Bearer wrong-token' },
    scope: 'jobs:create',
  }), (error) => {
    assert.equal(error.statusCode, 401);
    assert.doesNotMatch(error.message, /wrong-token|correct-token/);
    return true;
  });
});

test('loads service tokens from a token store and records audit decisions', async () => {
  const audits = [];
  const authorizer = new GatewayServiceAuthorizer({
    clock: () => new Date('2026-07-05T00:00:00.000Z'),
    tokenStore: {
      getServiceTokenByHash: (tokenHash) => (
        tokenHash === hashGatewayServiceToken('stored-token')
          ? {
            tokenHash,
            tokenRef: 'tok_stored',
            actor: 'task-weaver',
            scopes: ['jobs:create'],
            tenantIds: ['tenant_1'],
            projectIds: ['project_1'],
            expiresAt: '2026-07-06T00:00:00.000Z',
          }
          : null
      ),
      recordAudit: (record) => audits.push(record),
    },
  });

  const auth = await authorizer.authorize({
    headers: { authorization: 'Bearer stored-token' },
    scope: 'jobs:create',
    tenantId: 'tenant_1',
    projectId: 'project_1',
  });

  assert.equal(auth.tokenRef, 'tok_stored');
  assert.equal(audits[0].outcome, 'accepted');
  assert.equal(audits[0].tokenRef, 'tok_stored');

  await assert.rejects(() => authorizer.authorize({
    headers: { authorization: 'Bearer wrong-token' },
    scope: 'jobs:create',
    tenantId: 'tenant_1',
    projectId: 'project_1',
  }), /Invalid bearer token/);
  assert.equal(audits[1].outcome, 'denied');
});
