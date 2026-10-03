#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';

const host = process.env.SANDBOX_AGENT_HOST ?? '0.0.0.0';
const port = parseInteger(process.env.SANDBOX_AGENT_PORT, 8081);
const workspaceRoot = path.resolve(process.env.SANDBOX_WORKSPACE ?? '/workspace');
const authToken = process.env.SANDBOX_AGENT_TOKEN;
const maxBodyBytes = parseInteger(process.env.SANDBOX_AGENT_MAX_BODY_BYTES, 16 * 1024 * 1024);
let activeProcess = null;

if (!authToken) {
  throw new Error('SANDBOX_AGENT_TOKEN is required');
}

await mkdir(workspaceRoot, { recursive: true });

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      return sendJson(res, 200, { status: 'ok' });
    }
    if (!authorized(req)) {
      return sendJson(res, 401, { error: 'unauthorized' });
    }

    const url = new URL(req.url, 'http://sandbox-agent');
    if (req.method === 'POST' && url.pathname === '/v1/files/write') {
      const body = await readJson(req);
      const target = safeWorkspacePath(body.path);
      const content = decodeContent(body);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
      return sendJson(res, 200, { path: target, sizeBytes: content.byteLength });
    }
    if (req.method === 'GET' && url.pathname === '/v1/files/read') {
      const target = safeWorkspacePath(url.searchParams.get('path'));
      const content = await readFile(target);
      return sendJson(res, 200, {
        path: target,
        contentBase64: content.toString('base64'),
        sizeBytes: content.byteLength,
      });
    }
    if (req.method === 'POST' && url.pathname === '/v1/exec') {
      const body = await readJson(req);
      const result = await execute(body);
      return sendJson(res, 200, result);
    }
    if (req.method === 'POST' && url.pathname === '/v1/cancel') {
      if (activeProcess) {
        activeProcess.kill('SIGTERM');
        return sendJson(res, 200, { cancelled: true });
      }
      return sendJson(res, 200, { cancelled: false });
    }
    return sendJson(res, 404, { error: 'route not found' });
  } catch (error) {
    const status = error.statusCode ?? (error.code === 'ENOENT' ? 404 : 400);
    return sendJson(res, status, { error: error.message ?? String(error) });
  }
});

server.listen(port, host, () => {
  console.log(JSON.stringify({ message: 'sandbox agent started', host, port, workspaceRoot }));
});

function authorized(req) {
  return req.headers.authorization === `Bearer ${authToken}`;
}

async function execute(request) {
  if (!Array.isArray(request.argv) || request.argv.length === 0 || request.argv.some((item) => typeof item !== 'string')) {
    throw badRequest('argv must be a non-empty string array');
  }
  if (activeProcess) {
    throw Object.assign(new Error('sandbox is busy'), { statusCode: 409 });
  }

  const cwd = safeWorkspacePath(request.cwd ?? '/workspace');
  const timeoutSeconds = positiveNumber(request.timeoutSeconds, 120);
  const env = {
    PATH: process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: '/workspace',
    LANG: 'C.UTF-8',
    ...(request.env ?? {}),
  };
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      delete env[key];
    }
    if (typeof value !== 'string') {
      env[key] = String(value);
    }
  }

  const child = spawn(request.argv[0], request.argv.slice(1), {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  activeProcess = child;
  let stdout = '';
  let stderr = '';
  const append = (target, chunk) => {
    const next = target + chunk;
    return next.length > maxBodyBytes ? next.slice(0, maxBodyBytes) : next;
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
  child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });

  let timedOut = false;
  let killTimer = null;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
  }, timeoutSeconds * 1000);

  try {
    const exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve(code ?? 1));
    });
    return {
      id: `exec_${randomUUID()}`,
      exitCode,
      stdout,
      stderr,
      timedOut,
      cancelled: !timedOut && exitCode !== 0 && child.killed,
    };
  } finally {
    clearTimeout(timeout);
    if (killTimer) clearTimeout(killTimer);
    activeProcess = null;
  }
}

function safeWorkspacePath(input) {
  const raw = String(input ?? '/workspace');
  const relative = raw === '/' || raw === '/workspace'
    ? ''
    : raw.startsWith('/workspace/')
      ? raw.slice('/workspace/'.length)
      : raw.startsWith('/')
        ? raw.slice(1)
        : raw;
  const target = path.resolve(workspaceRoot, relative);
  if (target !== workspaceRoot && !target.startsWith(`${workspaceRoot}${path.sep}`)) {
    throw badRequest(`path escapes workspace: ${input}`);
  }
  return target;
}

function decodeContent(body) {
  if (body.contentBase64) {
    return Buffer.from(body.contentBase64, 'base64');
  }
  return Buffer.from(String(body.content ?? ''));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.byteLength;
    if (size > maxBodyBytes) {
      throw Object.assign(new Error('request body too large'), { statusCode: 413 });
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw badRequest('request body must be valid JSON');
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function parseInteger(value, fallback) {
  const number = Number.parseInt(value ?? '', 10);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}
