import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { WarmPoolManager } from '../src/gateway/warm-pool-manager.js';
import { LocalSandboxProvider } from '../src/providers/local-sandbox-provider.js';
import { CubeSandboxProvider } from '../src/providers/cubesandbox-provider.js';
import { InMemoryAgentExecutionGateway } from '../src/gateway/in-memory-agent-execution-gateway.js';

test('WarmPoolManager: prewarms instances and provides sub-50ms instant session acquisition', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'partners-warm-pool-'));
  const provider = new LocalSandboxProvider({ rootDir });
  const pool = new WarmPoolManager({
    provider,
    poolSize: 3,
    maxPoolSize: 5,
  });

  try {
    // 1. Initial warm up
    await pool.warmUp({ count: 2 });
    assert.equal(pool.totalWarmCount, 2);
    const statsInit = pool.getStats();
    assert.equal(statsInit.totalWarm, 2);
    assert.equal(statsInit.hits, 0);

    // 2. Acquire a session (Hit)
    const t0 = performance.now();
    const session = await pool.acquireSession({
      tenantId: 'tw-tenant-1',
      projectId: 'tw-proj-1',
    });
    const duration = performance.now() - t0;

    assert.ok(session.id);
    assert.equal(session.tenantId, 'tw-tenant-1');
    assert.equal(session.projectId, 'tw-proj-1');
    assert.equal(session.metadata.acquiredFromWarmPool, true);
    // Instant pickup should be well under 100ms
    assert.ok(duration < 100, `Expected < 100ms, took ${duration}ms`);

    const statsAfterHit = pool.getStats();
    assert.equal(statsAfterHit.hits, 1);

    // 3. Drain pool
    await pool.drain();
    assert.equal(pool.totalWarmCount, 0);
  } finally {
    await pool.drain();
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('WarmPoolManager: integrated into InMemoryAgentExecutionGateway for ultra-fast creation', async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'partners-warm-gw-'));
  const provider = new CubeSandboxProvider({ rootDir });
  const warmPool = new WarmPoolManager({
    provider,
    poolSize: 2,
  });

  await warmPool.warmUp({ count: 2 });
  assert.equal(warmPool.totalWarmCount, 2);

  const gateway = new InMemoryAgentExecutionGateway({
    provider,
    warmPool,
  });

  try {
    const t0 = performance.now();
    const session = await gateway.createSession({
      tenantId: 'task-weaver-core',
      projectId: 'proj-speed',
    });
    const duration = performance.now() - t0;

    assert.equal(session.tenantId, 'task-weaver-core');
    assert.equal(session.metadata.acquiredFromWarmPool, true);
    assert.ok(duration < 100, `Integrated warm session creation took ${duration}ms`);

    // Verify session is queryable in gateway
    const fetched = await gateway.getSession(session.id);
    assert.equal(fetched.id, session.id);
    assert.equal(fetched.tenantId, 'task-weaver-core');
  } finally {
    await warmPool.drain();
    await rm(rootDir, { recursive: true, force: true });
  }
});
