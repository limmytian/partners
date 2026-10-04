import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  CubeSandboxProvider,
  ExecutionMode,
  JobState,
  SandboxCapability,
} from '../src/index.js';

test('CubeSandboxProvider: sub-60ms session cold start and hardware virtualization', async () => {
  const provider = new CubeSandboxProvider();

  // Create session
  const startTime = performance.now();
  const session = await provider.createSession({
    resources: { vCpu: 2, memoryMib: 1024 },
  });
  const duration = performance.now() - startTime;

  assert.equal(session.provider, 'cubesandbox');
  assert.equal(session.state, 'ready');
  assert.equal(session.resources.vCpu, 2);
  assert.equal(session.microVm.isolation, 'hardware_virtualization_kvm');
  assert.equal(session.microVm.kernelVersion, '6.6.30-cube-microvm');

  // Verify sub-60ms cold start performance
  assert.ok(session.microVm.coldStartMs < 60, `Cold start took ${session.microVm.coldStartMs}ms, expected < 60ms`);

  // Verify capabilities
  assert.ok(provider.supports(SandboxCapability.MicroVMIsolation));
  assert.ok(provider.supports(SandboxCapability.MemorySnapshot));
  assert.ok(provider.supports(SandboxCapability.InstantFork));
  assert.ok(provider.supports(SandboxCapability.Sub60msColdStart));

  await provider.deleteSession(session.id);
});

test('CubeSandboxProvider: CubeCoW millisecond-level snapshot and instant fork', async () => {
  const provider = new CubeSandboxProvider();
  const session = await provider.createSession();

  // Write file in parent session
  await fs.writeFile(path.join(session.workspacePath, 'checkpoint.txt'), 'version_1_state');

  // 1. Snapshot
  const snapshot = await provider.createSnapshot(session.id, { label: 'pre-experiment' });
  assert.equal(snapshot.sessionId, session.id);
  assert.equal(snapshot.label, 'pre-experiment');
  assert.ok(snapshot.id.startsWith('cube_snap_'));

  // 2. Instant Fork from snapshot
  const forkedSession = await provider.forkFromSnapshot(snapshot.id);
  assert.equal(forkedSession.provider, 'cubesandbox');
  assert.equal(forkedSession.state, 'ready');
  assert.equal(forkedSession.microVm.forkedFrom, snapshot.id);
  assert.equal(forkedSession.microVm.parentSessionId, session.id);

  // Verify forked session has the snapshot data
  const forkedContent = await fs.readFile(path.join(forkedSession.workspacePath, 'checkpoint.txt'), 'utf8');
  assert.equal(forkedContent, 'version_1_state');

  // Modify forked session, verify parent session is isolated (CoW)
  await fs.writeFile(path.join(forkedSession.workspacePath, 'checkpoint.txt'), 'version_forked_state');
  const parentContent = await fs.readFile(path.join(session.workspacePath, 'checkpoint.txt'), 'utf8');
  assert.equal(parentContent, 'version_1_state');

  // Cleanup
  await provider.deleteSession(session.id);
  await provider.deleteSession(forkedSession.id);
});

test('CubeSandboxProvider: runs job in microvm session', async () => {
  const provider = new CubeSandboxProvider();
  const session = await provider.createSession();

  const events = [];
  const result = await provider.runJob({
    executionMode: ExecutionMode.WorkspaceSession,
    sessionId: session.id,
    code: 'console.log("microvm running");',
    timeoutSeconds: 30,
  }, (event) => events.push(event));

  assert.equal(result.state, JobState.Succeeded);
  assert.equal(result.provider, 'cubesandbox');
  assert.equal(result.microVm.kernel, '6.6.30-cube-microvm');
  assert.ok(result.stdout.includes('microvm running'));
  assert.ok(events.some((e) => e.type === 'microvm.ready'));

  await provider.deleteSession(session.id);
});
