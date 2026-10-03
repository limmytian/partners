#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import net from 'node:net';

const config = {
  baseUrl: trimTrailingSlash(process.env.GATEWAY_BASE_URL ?? 'http://127.0.0.1:18080'),
  token: process.env.GATEWAY_SERVICE_TOKEN ?? 'local-dev-token',
  tenantId: process.env.SMOKE_TENANT_ID ?? 'local',
  projectId: process.env.SMOKE_PROJECT_ID ?? 'partners',
  timeoutMs: parseInteger(process.env.SMOKE_TIMEOUT_MS, 30000),
  checkDependencies: isTruthy(process.env.SMOKE_CHECK_DEPENDENCIES),
  postgresHost: process.env.SMOKE_POSTGRES_HOST ?? '127.0.0.1',
  postgresPort: parseInteger(process.env.SMOKE_POSTGRES_PORT, 15432),
  minioHealthUrl: process.env.SMOKE_MINIO_HEALTH_URL ?? 'http://127.0.0.1:19000/minio/health/ready',
  restartCommand: process.env.SMOKE_RESTART_COMMAND ?? '',
  expectedArtifactBackend: process.env.SMOKE_EXPECT_ARTIFACT_BACKEND ?? '',
};

const startedAt = new Date();
const results = [];

try {
  await step('gateway health', async () => {
    await waitFor(async () => {
      const response = await fetchJson('/health', { auth: false });
      return response.status === 200 && response.body.status === 'ok';
    }, 'gateway health');
  });

  await step('gateway readiness', async () => {
    const response = await fetchJson('/ready', { auth: false });
    assertStatus(response, 200);
    assertEqual(response.body.status, 'ready', 'readiness status');
  });

  if (config.checkDependencies) {
    await step('postgres tcp readiness', async () => {
      await waitFor(() => canConnect(config.postgresHost, config.postgresPort), 'postgres tcp readiness');
    });
    await step('minio readiness', async () => {
      await waitFor(async () => {
        const response = await fetch(config.minioHealthUrl);
        return response.ok;
      }, 'minio readiness');
    });
  }

  if (config.token) {
    await step('missing token is denied', async () => {
      const response = await fetchJson('/v1/jobs', {
        auth: false,
        method: 'POST',
        body: successJobRequest(`job_missing_auth_${shortId()}`),
      });
      assertStatus(response, 401);
    });

    await step('out-of-scope tenant is forbidden', async () => {
      const response = await fetchJson('/v1/jobs', {
        method: 'POST',
        body: successJobRequest(`job_forbidden_${shortId()}`, { tenantId: 'outside-tenant' }),
      });
      assertStatus(response, 403);
    });
  }

  const sessionId = `ses_smoke_${shortId()}`;
  await step('session lifecycle', async () => {
    const created = await fetchJson('/v1/sessions', {
      method: 'POST',
      body: {
        id: sessionId,
        tenantId: config.tenantId,
        projectId: config.projectId,
        persistence: { kind: 'stopped' },
      },
    });
    assertStatus(created, 202);

    const fetched = await fetchJson(`/v1/sessions/${sessionId}`);
    assertStatus(fetched, 200);
    assertEqual(fetched.body.state, 'ready', 'session state');

    const deleted = await fetchJson(`/v1/sessions/${sessionId}`, { method: 'DELETE' });
    assertStatus(deleted, 202);
    assertEqual(deleted.body.state, 'deleted', 'deleted session state');
  });

  const successJobId = `job_smoke_success_${shortId()}`;
  await step('submit successful job', async () => {
    const created = await fetchJson('/v1/jobs', {
      method: 'POST',
      body: successJobRequest(successJobId),
    });
    assertStatus(created, 202);
    assertEqual(created.body.id, successJobId, 'job id');
  });

  await step('wait for successful job', async () => {
    const job = await waitForJobState(successJobId, 'succeeded');
    assertEqual(job.artifactCount, 2, 'artifact count');
  });

  const sandboxContractJobId = `job_smoke_sandbox_contract_${shortId()}`;
  await step('accept sandbox image and bootstrap contract', async () => {
    const response = await fetchJson('/v1/jobs', {
      method: 'POST',
      body: successJobRequest(sandboxContractJobId, {
        sandbox: {
          profile: 'smoke-tools',
          image: `registry.example/partners/smoke@sha256:${'a'.repeat(64)}`,
          imagePullSecretRef: 'platform://registry/smoke',
          init: {
            files: [{ path: '/workspace/bootstrap.sh', content: '#!/bin/sh\n' }],
            argv: ['/workspace/bootstrap.sh'],
            timeoutSeconds: 10,
            idempotencyKey: 'smoke-bootstrap-v1',
            version: 'v1',
          },
        },
      }),
    });
    assertStatus(response, 202);
    const job = await waitForJobState(sandboxContractJobId, 'succeeded');
    assertEqual(job.sandbox.imagePullSecretRef, 'platform://registry/smoke', 'sandbox secret reference');
    assert(!JSON.stringify(job).match(/ghp_|glpat-|BEGIN .*PRIVATE KEY/), 'sandbox response leaked secret material');
  });

  await step('read SSE replay', async () => {
    const events = await readSse(`/v1/jobs/${successJobId}/events`);
    assert(events.some((event) => event.type === 'job.state'), 'missing job.state event');
    assert(events.some((event) => event.type === 'job.final'), 'missing job.final event');

    const replay = await readSse(`/v1/jobs/${successJobId}/events`, {
      headers: { 'Last-Event-ID': '1' },
    });
    assert(replay.length > 0, 'empty Last-Event-ID replay');
    assert(replay.every((event) => event.sequence > 1), 'replay included old events');
  });

  await step('download artifact', async () => {
    const artifacts = await fetchJson(`/v1/jobs/${successJobId}/artifacts`);
    assertStatus(artifacts, 200);
    const valueArtifact = artifacts.body.items.find((item) => item.name === 'value.txt');
    assert(valueArtifact, 'value.txt artifact not found');
    assert(!valueArtifact.localPath, 'artifact exposed a local path');
    assertEqual(valueArtifact.sha256, createHash('sha256').update('smoke-ok').digest('hex'), 'artifact sha256');
    assertEqual(valueArtifact.contentType, 'application/octet-stream', 'artifact content type');
    if (config.expectedArtifactBackend === 's3') {
      assert(valueArtifact.storageUri?.startsWith('s3://'), 'artifact is not stored in S3');
      assert(valueArtifact.downloadHandle?.startsWith('artifact://s3/'), 'artifact did not use S3 download handle');
      assert(valueArtifact.metadata?.s3?.key, 'artifact is missing S3 key metadata');
    }

    const response = await fetchUrl(`/v1/artifacts/${valueArtifact.id}/download`);
    assertEqual(response.status, 200, 'download status');
    const content = await response.text();
    assertEqual(content, 'smoke-ok', 'download content');
    return {
      artifact: {
        id: valueArtifact.id,
        bytes: Buffer.byteLength(content),
        sha256: createHash('sha256').update(content).digest('hex'),
      },
    };
  });

  await step('read metrics', async () => {
    const response = await fetchUrl('/metrics', { auth: false });
    assertEqual(response.status, 200, 'metrics status');
    const text = await response.text();
    assert(text.includes('partners_gateway_http_requests_total'), 'missing request metric');
  });

  const cancelJobId = `job_smoke_cancel_${shortId()}`;
  await step('cancel running job', async () => {
    const created = await fetchJson('/v1/jobs', {
      method: 'POST',
      body: {
        id: cancelJobId,
        tenantId: config.tenantId,
        projectId: config.projectId,
        executionMode: 'ephemeral_interpreter',
        command: {
          argv: ['node', '-e', 'setTimeout(() => console.log("late"), 10000)'],
        },
        timeoutSeconds: 30,
      },
    });
    assertStatus(created, 202);

    const cancelled = await fetchJson(`/v1/jobs/${cancelJobId}/cancel`, {
      method: 'POST',
      body: { reason: 'smoke cancellation' },
    });
    assertStatus(cancelled, 202);

    await waitForJobState(cancelJobId, 'cancelled');
  });

  if (config.restartCommand) {
    await step('restart gateway', async () => {
      const result = spawnSync('sh', ['-c', config.restartCommand], {
        cwd: process.cwd(),
        encoding: 'utf8',
      });
      if (result.status !== 0) {
        throw new Error(`restart command failed: ${result.stderr || result.stdout}`);
      }
      await waitFor(async () => {
        const response = await fetchJson('/health', { auth: false });
        return response.status === 200 && response.body.status === 'ok';
      }, 'gateway health after restart');
    });

    await step('verify restart durability', async () => {
      const job = await fetchJson(`/v1/jobs/${successJobId}`);
      assertStatus(job, 200);
      assertEqual(job.body.state, 'succeeded', 'restarted job state');

      const cancelled = await fetchJson(`/v1/jobs/${cancelJobId}`);
      assertStatus(cancelled, 200);
      assertEqual(cancelled.body.state, 'cancelled', 'restarted cancelled job state');

      const events = await readSse(`/v1/jobs/${successJobId}/events`);
      assert(events.some((event) => event.type === 'job.final'), 'restart lost final event');

      const artifacts = await fetchJson(`/v1/jobs/${successJobId}/artifacts`);
      assertStatus(artifacts, 200);
      const valueArtifact = artifacts.body.items.find((item) => item.name === 'value.txt');
      assert(valueArtifact, 'restart lost artifact manifest');
      if (config.expectedArtifactBackend === 's3') {
        assert(valueArtifact.storageUri?.startsWith('s3://'), 'restart lost S3 storage URI');
        assertEqual(valueArtifact.sha256, createHash('sha256').update('smoke-ok').digest('hex'), 'restart artifact sha256');
      }

      const response = await fetchUrl(`/v1/artifacts/${valueArtifact.id}/download`);
      assertEqual(response.status, 200, 'restart download status');
      assertEqual(await response.text(), 'smoke-ok', 'restart download content');
    });
  }

  writeSummary(true);
} catch (error) {
  results.push({
    name: 'unhandled failure',
    ok: false,
    error: error.message,
  });
  writeSummary(false);
  process.exitCode = 1;
}

async function step(name, fn) {
  const started = Date.now();
  try {
    const details = await fn();
    results.push({
      name,
      ok: true,
      durationMs: Date.now() - started,
      ...(details ?? {}),
    });
  } catch (error) {
    results.push({
      name,
      ok: false,
      durationMs: Date.now() - started,
      error: error.message,
    });
    throw error;
  }
}

function successJobRequest(id, overrides = {}) {
  return {
    id,
    tenantId: config.tenantId,
    projectId: config.projectId,
    executionMode: 'ephemeral_interpreter',
    inputs: {
      files: [{ path: '/workspace/input.txt', content: 'smoke-ok' }],
    },
    command: {
      argv: [
        'node',
        '-e',
        "const fs=require('fs'); const v=fs.readFileSync('input.txt','utf8'); fs.mkdirSync('out',{recursive:true}); fs.writeFileSync('out/value.txt', v); console.log(v);",
      ],
      cwd: '/workspace',
    },
    timeoutSeconds: 30,
    artifactPolicy: {
      collect: ['workspace:/workspace/out/value.txt'],
    },
    ...overrides,
  };
}

async function waitForJobState(jobId, expectedState) {
  let latest;
  await waitFor(async () => {
    const response = await fetchJson(`/v1/jobs/${jobId}`);
    if (response.status !== 200) {
      return false;
    }
    latest = response.body;
    return latest.state === expectedState;
  }, `job ${jobId} state ${expectedState}`);
  return latest;
}

async function readSse(path, options = {}) {
  const response = await fetchUrl(path, options);
  assertEqual(response.status, 200, `${path} status`);
  const text = await response.text();
  return text
    .trim()
    .split('\n\n')
    .filter(Boolean)
    .map((chunk) => {
      const dataLine = chunk.split('\n').find((line) => line.startsWith('data: '));
      return dataLine ? JSON.parse(dataLine.slice('data: '.length)) : null;
    })
    .filter(Boolean);
}

async function fetchJson(path, { method = 'GET', body, headers = {}, auth = true } = {}) {
  const response = await fetchUrl(path, { method, body, headers, auth });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
  };
}

function fetchUrl(path, { method = 'GET', body, headers = {}, auth = true } = {}) {
  return fetch(`${config.baseUrl}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(auth && config.token ? { Authorization: `Bearer ${config.token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(config.timeoutMs),
  });
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + config.timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ''}`);
}

function canConnect(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 500);
    socket.once('connect', () => {
      clearTimeout(timeout);
      socket.end();
      resolve(true);
    });
    socket.once('error', () => {
      clearTimeout(timeout);
      resolve(false);
    });
  });
}

function assertStatus(response, expected) {
  assertEqual(response.status, expected, `HTTP status ${JSON.stringify(response.body)}`);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shortId() {
  return randomUUID().slice(0, 8);
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function isTruthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').toLowerCase());
}

function writeSummary(ok) {
  const finishedAt = new Date();
  console.log(JSON.stringify({
    ok,
    baseUrl: config.baseUrl,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    checks: results,
  }, null, 2));
}
