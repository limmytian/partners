import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';

import { createCubeSandboxMockServer } from './helpers/cubesandbox-mock-server.js';

test('scripts/gateway-service.mjs boots with GATEWAY_PROVIDER=cubesandbox and handles requests', async () => {
  const mockServer = await createCubeSandboxMockServer();
  const gatewayPort = 18090 + Math.floor(Math.random() * 1000);
  const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;

  const env = {
    ...process.env,
    GATEWAY_HOST: '127.0.0.1',
    GATEWAY_PORT: String(gatewayPort),
    GATEWAY_PROVIDER: 'cubesandbox',
    CUBESANDBOX_ENDPOINT: mockServer.url,
    GATEWAY_STORE: 'memory',
    GATEWAY_ARTIFACT_STORE: 'local',
  };

  const proc = spawn('node', ['scripts/gateway-service.mjs'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let procExited = false;
  proc.on('exit', () => {
    procExited = true;
  });

  try {
    // 1. Wait for gateway readiness
    let ready = false;
    for (let i = 0; i < 40; i++) {
      if (procExited) break;
      try {
        const res = await fetch(`${gatewayUrl}/ready`);
        if (res.ok) {
          const body = await res.json();
          if (body.provider === 'cubesandbox' && body.status === 'ready') {
            ready = true;
            break;
          }
        }
      } catch {
        // waiting for port open
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    assert.equal(ready, true, 'Gateway service did not become ready with cubesandbox provider');

    // 2. Call standard /v1/sessions API
    const resSession = await fetch(`${gatewayUrl}/v1/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        resources: { vCpu: 2, memoryMib: 1024 },
      }),
    });
    assert.equal(resSession.status, 202);
    const session = await resSession.json();
    assert.equal(session.provider, 'cubesandbox');

    // 3. Submit a job
    const resJob = await fetch(`${gatewayUrl}/v1/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        executionMode: 'workspace_session',
        sessionId: session.id,
        command: { argv: ['echo', 'testing gateway cubesandbox service'] },
        timeoutSeconds: 30,
      }),
    });
    assert.equal(resJob.status, 202);
    const job = await resJob.json();
    assert.ok(job.id);
  } finally {
    proc.kill('SIGTERM');
    await new Promise((resolve) => proc.on('close', resolve));
    await mockServer.close();
  }
});
