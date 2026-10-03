import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ExecutionMode,
  InMemoryAgentExecutionGateway,
  InMemoryGatewayStore,
  JobState,
  SessionState,
} from '../src/index.js';
import { createAgentExecutionGatewayServer } from '../src/gateway/http-agent-execution-gateway.js';
import { GatewayServiceAuthorizer } from '../src/security/gateway-service-auth.js';

test('InMemoryGatewayStore supports admin queries and overview aggregations', () => {
  const store = new InMemoryGatewayStore();

  store.saveSession({
    id: 'ses_1',
    state: SessionState.Ready,
    tenantId: 'tenant_a',
    projectId: 'proj_1',
    createdAt: '2026-09-08T10:00:00.000Z',
  });
  store.saveSession({
    id: 'ses_2',
    state: SessionState.Stopped,
    tenantId: 'tenant_b',
    projectId: 'proj_2',
    createdAt: '2026-09-08T11:00:00.000Z',
  });

  store.saveJob({
    id: 'job_1',
    state: JobState.Running,
    tenantId: 'tenant_a',
    projectId: 'proj_1',
    sessionId: 'ses_1',
    createdAt: '2026-09-08T10:05:00.000Z',
  });
  store.saveJob({
    id: 'job_2',
    state: JobState.Succeeded,
    tenantId: 'tenant_a',
    projectId: 'proj_1',
    createdAt: '2026-09-08T10:10:00.000Z',
  });

  store.recordAudit({
    id: 'aud_1',
    action: 'authorize',
    scope: 'jobs:create',
    tokenRef: 'tok_1',
    actor: 'agent_tw',
    tenantId: 'tenant_a',
    outcome: 'accepted',
  });
  store.recordAudit({
    id: 'aud_2',
    action: 'authorize',
    scope: 'jobs:create',
    tokenRef: 'tok_bad',
    actor: 'anonymous',
    tenantId: 'tenant_b',
    outcome: 'denied',
  });

  store.saveIdempotencyKey('idem_1', {
    tenantId: 'tenant_a',
    scope: 'jobs:create',
    requestHash: 'hash_1',
  });

  const sessionsA = store.listSessions({ tenantId: 'tenant_a' });
  assert.equal(sessionsA.length, 1);
  assert.equal(sessionsA[0].id, 'ses_1');

  const jobsRunning = store.listJobs({ state: JobState.Running });
  assert.equal(jobsRunning.length, 1);
  assert.equal(jobsRunning[0].id, 'job_1');

  const auditsDenied = store.listAuditRecords({ outcome: 'denied' });
  assert.equal(auditsDenied.length, 1);
  assert.equal(auditsDenied[0].id, 'aud_2');

  const keys = store.listIdempotencyKeys({ tenantId: 'tenant_a' });
  assert.equal(keys.length, 1);
  assert.equal(keys[0].key, 'idem_1');

  const overview = store.getOverview();
  assert.equal(overview.jobs.total, 2);
  assert.equal(overview.jobs.running, 1);
  assert.equal(overview.sessions.total, 2);
  assert.equal(overview.sessions.active, 1);
  assert.equal(overview.auditRecordsCount, 2);
  assert.equal(overview.idempotencyKeysCount, 1);
});

test('HTTP gateway exposes /v1/admin endpoints with scoped authorization and CORS', async () => {
  const store = new InMemoryGatewayStore();
  const provider = {
    name: 'fake',
    runJob: async () => ({
      state: JobState.Succeeded,
      executionMode: ExecutionMode.EphemeralInterpreter,
      provider: 'fake',
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      artifacts: [],
      completedAt: new Date().toISOString(),
    }),
    cancel: async () => {},
    stopSession: async () => {},
  };
  const gateway = new InMemoryAgentExecutionGateway({ provider, store });

  store.saveSession({
    id: 'ses_admin_1',
    state: SessionState.Ready,
    tenantId: 'tenant_ops',
    projectId: 'proj_ops',
    createdAt: '2026-09-08T10:00:00.000Z',
  });
  store.saveJob({
    id: 'job_admin_1',
    state: JobState.Running,
    tenantId: 'tenant_ops',
    projectId: 'proj_ops',
    createdAt: '2026-09-08T10:05:00.000Z',
  });

  const authorizer = new GatewayServiceAuthorizer({
    tokens: [
      {
        token: 'admin-read-token',
        tokenRef: 'tok_admin_read',
        actor: 'admin_viewer',
        scopes: ['admin:read'],
      },
      {
        token: 'admin-operate-token',
        tokenRef: 'tok_admin_ops',
        actor: 'admin_operator',
        scopes: ['admin:read', 'admin:operate'],
      },
      {
        token: 'user-token',
        tokenRef: 'tok_user',
        actor: 'regular_user',
        scopes: ['jobs:create', 'jobs:read'],
      },
    ],
    tokenStore: store,
  });

  const { server, close } = createAgentExecutionGatewayServer({
    gateway,
    authorizer,
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. CORS Preflight
    const optionsRes = await fetch(`${baseUrl}/v1/admin/overview`, {
      method: 'OPTIONS',
    });
    assert.equal(optionsRes.status, 204);
    assert.equal(optionsRes.headers.get('access-control-allow-origin'), '*');
    assert.match(optionsRes.headers.get('access-control-allow-methods'), /GET, POST, DELETE, OPTIONS/);

    // 2. Missing token -> 401
    const unauthRes = await fetch(`${baseUrl}/v1/admin/overview`);
    assert.equal(unauthRes.status, 401);

    // 3. User token lacking admin:read scope -> 403
    const forbiddenRes = await fetch(`${baseUrl}/v1/admin/overview`, {
      headers: { Authorization: 'Bearer user-token' },
    });
    assert.equal(forbiddenRes.status, 403);

    // 4. Admin read token -> GET /v1/admin/overview 200
    const overviewRes = await fetch(`${baseUrl}/v1/admin/overview`, {
      headers: { Authorization: 'Bearer admin-read-token' },
    });
    assert.equal(overviewRes.status, 200);
    const overviewData = await overviewRes.json();
    assert.equal(overviewData.jobs.total, 1);
    assert.equal(overviewData.jobs.running, 1);
    assert.equal(overviewData.sessions.total, 1);
    assert.equal(overviewData.sessions.active, 1);
    assert.equal(typeof overviewData.uptimeSeconds, 'number');

    // 5. GET /v1/admin/jobs
    const jobsRes = await fetch(`${baseUrl}/v1/admin/jobs?state=running`, {
      headers: { Authorization: 'Bearer admin-read-token' },
    });
    assert.equal(jobsRes.status, 200);
    const jobsData = await jobsRes.json();
    assert.equal(jobsData.items.length, 1);
    assert.equal(jobsData.items[0].id, 'job_admin_1');

    // 6. GET /v1/admin/sessions
    const sessionsRes = await fetch(`${baseUrl}/v1/admin/sessions`, {
      headers: { Authorization: 'Bearer admin-read-token' },
    });
    assert.equal(sessionsRes.status, 200);
    const sessionsData = await sessionsRes.json();
    assert.equal(sessionsData.items.length, 1);
    assert.equal(sessionsData.items[0].id, 'ses_admin_1');

    // 7. GET /v1/admin/audit-records
    const auditRes = await fetch(`${baseUrl}/v1/admin/audit-records`, {
      headers: { Authorization: 'Bearer admin-read-token' },
    });
    assert.equal(auditRes.status, 200);
    const auditData = await auditRes.json();
    assert.ok(Array.isArray(auditData.items));

    // 8. Admin Operate: cancel job with admin:read only -> 403
    const cancelDenied = await fetch(`${baseUrl}/v1/admin/jobs/job_admin_1/cancel`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer admin-read-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ reason: 'emergency stop' }),
    });
    assert.equal(cancelDenied.status, 403);

    // 9. Admin Operate: cancel job with admin-operate-token -> 202
    const cancelRes = await fetch(`${baseUrl}/v1/admin/jobs/job_admin_1/cancel`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer admin-operate-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ reason: 'emergency stop' }),
    });
    assert.equal(cancelRes.status, 202);
    const cancelledJob = await cancelRes.json();
    assert.equal(cancelledJob.state, JobState.CancelRequested);

    // 10. Admin Operate: stop session with admin-operate-token -> 202
    const stopRes = await fetch(`${baseUrl}/v1/admin/sessions/ses_admin_1/stop`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer admin-operate-token',
        'Content-Type': 'application/json',
      },
    });
    assert.equal(stopRes.status, 202);
    const stoppedSession = await stopRes.json();
    assert.equal(stoppedSession.state, SessionState.Stopped);
  } finally {
    await close();
  }
});
