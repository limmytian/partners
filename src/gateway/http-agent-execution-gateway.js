import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { extname } from 'node:path';

import { GatewayServiceAuthorizer, redactAuthError } from '../security/gateway-service-auth.js';
import { WebSocketStream } from './websocket-stream.js';

const TERMINAL_JOB_STATES = new Set(['succeeded', 'failed', 'timed_out', 'cancelled']);

export function createAgentExecutionGatewayServer({
  gateway,
  authorizer = new GatewayServiceAuthorizer(),
  logger = { error: (...args) => console.error(...args) },
  readiness = () => ({ status: 'ready' }),
  metrics = null,
} = {}) {
  if (!gateway) {
    throw new TypeError('createAgentExecutionGatewayServer requires a gateway');
  }

  const eventBus = new EventEmitter();
  eventBus.setMaxListeners(0);
  const runningJobs = new Map();

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key, Last-Event-ID');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    const startedAt = Date.now();
    res.on('finish', () => {
      const durationMs = Date.now() - startedAt;
      metrics?.recordRequest?.({
        method: req.method,
        path: new URL(req.url, 'http://localhost').pathname,
        statusCode: res.statusCode,
        durationMs,
      });
      logger.info?.({
        message: 'http request',
        method: req.method,
        path: new URL(req.url, 'http://localhost').pathname,
        statusCode: res.statusCode,
        durationMs,
      });
    });
    try {
      await routeRequest({ req, res, gateway, authorizer, eventBus, runningJobs, logger, readiness, metrics });
    } catch (error) {
      const statusCode = statusForError(error);
      if (statusCode >= 500) {
        logger.error?.(error);
      }
      sendJson(res, statusCode, statusCode === 401 || statusCode === 403
        ? redactAuthError(error)
        : { error: error?.message ?? 'Internal server error' });
    }
  });

  server.on('upgrade', async (req, socket, head) => {
    try {
      await handleUpgrade({ req, socket, head, gateway, authorizer, logger });
    } catch (error) {
      const statusCode = statusForError(error);
      const message = error?.message ?? 'Upgrade failed';
      socket.write(
        `HTTP/1.1 ${statusCode} ${http.STATUS_CODES[statusCode] || 'Error'}\r\n` +
        'Connection: close\r\n' +
        'Content-Type: text/plain; charset=utf-8\r\n\r\n' +
        message
      );
      socket.destroy();
    }
  });

  return {
    server,
    listen: (...args) => server.listen(...args),
    close: () => new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

async function routeRequest({ req, res, gateway, authorizer, eventBus, runningJobs, logger, readiness, metrics }) {
  const url = new URL(req.url, 'http://localhost');
  const segments = url.pathname.split('/').filter(Boolean);

  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJson(res, 200, { status: 'ok' });
  }

  if (req.method === 'GET' && url.pathname === '/ready') {
    const ready = await readiness();
    return sendJson(res, ready.status === 'ready' ? 200 : 503, ready);
  }

  if (req.method === 'GET' && url.pathname === '/metrics') {
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
    return res.end(metrics?.prometheus?.() ?? '');
  }

  if (segments[0] !== 'v1') {
    return sendJson(res, 404, { error: 'Route not found' });
  }

  if (segments[1] === 'admin') {
    if (req.method === 'GET' && segments[2] === 'overview') {
      await authorize({ req, authorizer, scope: 'admin:read' });
      const overview = (await gateway.getOverview?.()) ?? {};
      return sendJson(res, 200, overview);
    }
    if (req.method === 'GET' && segments[2] === 'jobs') {
      await authorize({ req, authorizer, scope: 'admin:read' });
      const tenantId = url.searchParams.get('tenantId') || undefined;
      const projectId = url.searchParams.get('projectId') || undefined;
      const sessionId = url.searchParams.get('sessionId') || undefined;
      const state = url.searchParams.get('state') || undefined;
      const limit = Number.parseInt(url.searchParams.get('limit') || '50', 10);
      const offset = Number.parseInt(url.searchParams.get('offset') || '0', 10);
      const items = (await gateway.listJobs?.({ tenantId, projectId, sessionId, state, limit, offset })) ?? [];
      return sendJson(res, 200, { items: items.map(sanitizeJob), limit, offset });
    }
    if (req.method === 'GET' && segments[2] === 'sessions') {
      await authorize({ req, authorizer, scope: 'admin:read' });
      const tenantId = url.searchParams.get('tenantId') || undefined;
      const projectId = url.searchParams.get('projectId') || undefined;
      const state = url.searchParams.get('state') || undefined;
      const limit = Number.parseInt(url.searchParams.get('limit') || '50', 10);
      const offset = Number.parseInt(url.searchParams.get('offset') || '0', 10);
      const items = (await gateway.listSessions?.({ tenantId, projectId, state, limit, offset })) ?? [];
      return sendJson(res, 200, { items: items.map(sanitizeSession), limit, offset });
    }
    if (req.method === 'GET' && segments[2] === 'audit-records') {
      await authorize({ req, authorizer, scope: 'admin:read' });
      const tokenRef = url.searchParams.get('tokenRef') || undefined;
      const actor = url.searchParams.get('actor') || undefined;
      const action = url.searchParams.get('action') || undefined;
      const outcome = url.searchParams.get('outcome') || undefined;
      const tenantId = url.searchParams.get('tenantId') || undefined;
      const projectId = url.searchParams.get('projectId') || undefined;
      const limit = Number.parseInt(url.searchParams.get('limit') || '50', 10);
      const offset = Number.parseInt(url.searchParams.get('offset') || '0', 10);
      const items = (await gateway.listAuditRecords?.({ tokenRef, actor, action, outcome, tenantId, projectId, limit, offset })) ?? [];
      return sendJson(res, 200, { items, limit, offset });
    }
    if (req.method === 'GET' && segments[2] === 'idempotency-keys') {
      await authorize({ req, authorizer, scope: 'admin:read' });
      const tenantId = url.searchParams.get('tenantId') || undefined;
      const scope = url.searchParams.get('scope') || undefined;
      const limit = Number.parseInt(url.searchParams.get('limit') || '50', 10);
      const offset = Number.parseInt(url.searchParams.get('offset') || '0', 10);
      const items = (await gateway.listIdempotencyKeys?.({ tenantId, scope, limit, offset })) ?? [];
      return sendJson(res, 200, { items, limit, offset });
    }
    if (req.method === 'POST' && segments[2] === 'jobs' && segments[4] === 'cancel') {
      const jobId = segments[3];
      await authorize({ req, authorizer, scope: 'admin:operate' });
      const { reason = 'cancelled by admin' } = await readJson(req, { allowEmpty: true });
      const job = await gateway.cancel(jobId, reason);
      return job
        ? sendJson(res, 202, sanitizeJob(job))
        : sendJson(res, 404, { error: 'Job not found' });
    }
    if (req.method === 'POST' && segments[2] === 'sessions' && segments[4] === 'stop') {
      const sessionId = segments[3];
      await authorize({ req, authorizer, scope: 'admin:operate' });
      const session = await gateway.stopSession?.(sessionId);
      return session
        ? sendJson(res, 202, sanitizeSession(session))
        : sendJson(res, 404, { error: 'Session not found' });
    }
    return sendJson(res, 404, { error: 'Admin route not found' });
  }

  if (req.method === 'POST' && segments.length === 2 && segments[1] === 'sessions') {
    const body = await readJson(req);
    const auth = await authorize({ req, authorizer, scope: 'sessions:create', body });
    const session = await gateway.createSession(withAuthContext(body, auth));
    return sendJson(res, 202, sanitizeSession(session));
  }

  if (segments[1] === 'sessions' && segments[2]) {
    const sessionId = segments[2];
    if (req.method === 'GET' && segments.length === 3) {
      const session = await gateway.getSession(sessionId);
      if (session) {
        await authorize({ req, authorizer, scope: 'sessions:read', resource: session });
      }
      return session
        ? sendJson(res, 200, sanitizeSession(session))
        : sendJson(res, 404, { error: 'Session not found' });
    }
    if (req.method === 'DELETE' && segments.length === 3) {
      const existing = await gateway.getSession(sessionId);
      if (existing) {
        await authorize({ req, authorizer, scope: 'sessions:delete', resource: existing });
      }
      const session = await gateway.deleteSession(sessionId);
      return sendJson(res, 202, sanitizeSession(session));
    }
    if (req.method === 'GET' && segments.length === 5 && segments[3] === 'workspace' && segments[4] === 'tree') {
      const session = await gateway.getSession(sessionId);
      if (!session) {
        return sendJson(res, 404, { error: 'Session not found' });
      }
      await authorize({ req, authorizer, scope: 'sessions:read', resource: session });
      const subpath = url.searchParams.get('path') || '.';
      const depth = Number.parseInt(url.searchParams.get('depth') || '3', 10);
      const includeHidden = url.searchParams.get('includeHidden') !== 'false';
      const tree = await gateway.listSessionWorkspaceTree(sessionId, { subpath, depth, includeHidden });
      return sendJson(res, 200, tree);
    }
    if (req.method === 'GET' && segments.length === 5 && segments[3] === 'workspace' && segments[4] === 'file') {
      const session = await gateway.getSession(sessionId);
      if (!session) {
        return sendJson(res, 404, { error: 'Session not found' });
      }
      await authorize({ req, authorizer, scope: 'sessions:read', resource: session });
      const filePath = url.searchParams.get('path');
      if (!filePath) {
        return sendJson(res, 400, { error: 'Query parameter "path" is required' });
      }
      const allowSensitiveRedact = url.searchParams.get('redact') !== 'false';
      const preview = await gateway.readSessionWorkspaceFile(sessionId, filePath, { allowSensitiveRedact });
      return sendJson(res, 200, preview);
    }
    if (req.method === 'GET' && segments.length === 5 && segments[3] === 'workspace' && segments[4] === 'download') {
      const session = await gateway.getSession(sessionId);
      if (!session) {
        return sendJson(res, 404, { error: 'Session not found' });
      }
      await authorize({ req, authorizer, scope: 'sessions:read', resource: session });
      const filePath = url.searchParams.get('path');
      const archive = url.searchParams.get('archive') === 'true' || !filePath;

      if (!archive) {
        const { stream, filename, sizeBytes, mimeType } = await gateway.downloadSessionWorkspaceFile(sessionId, filePath);
        res.writeHead(200, {
          'Content-Type': mimeType,
          'Content-Length': sizeBytes,
          'Content-Disposition': `attachment; filename="${safeHeaderFilename(filename)}"`,
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'",
        });
        return stream.pipe(res);
      }

      const pathsParam = url.searchParams.get('paths');
      const paths = pathsParam ? pathsParam.split(',').map((p) => p.trim()).filter(Boolean) : (filePath ? [filePath] : ['.']);
      const archiveName = url.searchParams.get('archiveName') || `session-${sessionId}-workspace.tar.gz`;
      const { stream, filename } = await gateway.downloadSessionWorkspaceArchive(sessionId, { paths, archiveName });

      res.writeHead(200, {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="${safeHeaderFilename(filename)}"`,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'",
      });
      return stream.pipe(res);
    }
    if (req.method === 'POST' && ['stop', 'archive'].includes(segments[3])) {
      return sendJson(res, 501, { error: `${segments[3]} session is not implemented yet` });
    }
    if (req.method === 'POST' && (segments[3] === 'pty' || segments[3] === 'shell')) {
      const session = await gateway.getSession(sessionId);
      if (!session) {
        return sendJson(res, 404, { error: 'Session not found' });
      }
      await authorize({ req, authorizer, scope: 'sessions:shell', resource: session });
      const body = await readJson(req, { allowEmpty: true });
      const wsUrl = `ws://${req.headers.host || 'localhost'}/v1/sessions/${encodeURIComponent(sessionId)}/pty`;
      return sendJson(res, 200, {
        sessionId,
        wsUrl,
        ptyEndpoint: `/v1/sessions/${encodeURIComponent(sessionId)}/pty`,
        command: body.command ?? '/bin/sh',
        cols: body.cols ?? 80,
        rows: body.rows ?? 24,
      });
    }
  }

  if (req.method === 'POST' && segments.length === 2 && segments[1] === 'jobs') {
    const request = await readJson(req);
    const auth = await authorize({ req, authorizer, scope: 'jobs:create', body: request });
    const idempotencyKey = singleHeader(req.headers['idempotency-key'], 'Idempotency-Key');
    const hasIdempotencyKey = idempotencyKey !== null;
    if (hasIdempotencyKey) {
      const replay = await gateway.getJobIdempotencyRecord?.({ idempotencyKey, request });
      if (replay) {
        return replay.matchesRequest
          ? sendJson(res, replay.statusCode ?? 202, replay.responseBody)
          : sendJson(res, 409, {
              error: 'Idempotency-Key has already been used with a different request body',
            });
      }
    }

    const events = [];
    let jobId = request.id;
    const publish = (event) => {
      events.push(event);
      eventBus.emit(event.jobId, event);
    };
    const completion = gateway.createJob(withAuthContext(request, auth), publish)
      .finally(() => runningJobs.delete(jobId));
    completion.catch(() => {});
    jobId = await waitForJobId({ gateway, events, completion, requestedJobId: jobId });
    if (!jobId || !(await gateway.getJob(jobId))) {
      await completion;
      throw Object.assign(new Error('Job was not accepted'), { statusCode: 500 });
    }
    runningJobs.set(jobId, completion);
    const responseBody = sanitizeJob(await gateway.getJob(jobId));
    if (hasIdempotencyKey) {
      await gateway.saveJobIdempotencyRecord?.({
        idempotencyKey,
        request,
        statusCode: 202,
        responseBody,
      });
    }
    return sendJson(res, 202, responseBody);
  }

  if (segments[1] === 'jobs' && segments[2]) {
    const jobId = segments[2];
    if (req.method === 'GET' && segments.length === 3) {
      const job = await gateway.getJob(jobId);
      if (job) {
        await authorize({ req, authorizer, scope: 'jobs:read', resource: job });
      }
      return job
        ? sendJson(res, 200, sanitizeJob(job))
        : sendJson(res, 404, { error: 'Job not found' });
    }
    if (req.method === 'POST' && segments[3] === 'cancel') {
      const existing = await gateway.getJob(jobId);
      if (existing) {
        await authorize({ req, authorizer, scope: 'jobs:cancel', resource: existing });
      }
      const { reason } = await readJson(req, { allowEmpty: true });
      const job = await gateway.cancel(jobId, reason);
      return job
        ? sendJson(res, 202, sanitizeJob(job))
        : sendJson(res, 404, { error: 'Job not found' });
    }
    if (req.method === 'GET' && segments[3] === 'events') {
      const job = await gateway.getJob(jobId);
      if (job) {
        await authorize({ req, authorizer, scope: 'jobs:read', resource: job });
      }
      return streamJobEvents({ req, res, gateway, eventBus, jobId });
    }
    if (req.method === 'GET' && segments[3] === 'artifacts') {
      const job = await gateway.getJob(jobId);
      if (!job) {
        return sendJson(res, 404, { error: 'Job not found' });
      }
      await authorize({ req, authorizer, scope: 'artifacts:read', resource: job });
      return sendJson(res, 200, {
        items: (await gateway.listJobArtifacts(jobId)).map(sanitizeArtifact),
      });
    }
  }

  if (
    req.method === 'GET'
    && segments.length === 4
    && segments[1] === 'artifacts'
    && segments[3] === 'download'
  ) {
    return downloadArtifact({ req, res, gateway, authorizer, artifactId: segments[2] });
  }

  return sendJson(res, 404, { error: 'Route not found' });
}

async function streamJobEvents({ req, res, gateway, eventBus, jobId }) {
  const job = await gateway.getJob(jobId);
  if (!job) {
    return sendJson(res, 404, { error: 'Job not found' });
  }

  const afterSequence = parseLastEventId(req.headers['last-event-id']);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });

  let lastSequence = afterSequence;
  const writeEvent = (event) => {
    if (event.sequence <= lastSequence) {
      return;
    }
    lastSequence = event.sequence;
    res.write(`id: ${event.sequence}\n`);
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  for (const event of await gateway.listJobEvents(jobId, { afterSequence })) {
    writeEvent(event);
  }

  const latest = await gateway.getJob(jobId);
  if (TERMINAL_JOB_STATES.has(latest?.state)) {
    return res.end();
  }

  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 15000);
  const listener = (event) => {
    writeEvent(event);
    void (async () => {
      const current = await gateway.getJob(jobId);
      if (TERMINAL_JOB_STATES.has(current?.state)) {
        cleanup();
        res.end();
      }
    })();
  };
  const cleanup = () => {
    clearInterval(heartbeat);
    eventBus.off(jobId, listener);
  };

  eventBus.on(jobId, listener);
  req.on('close', cleanup);
}

async function downloadArtifact({ req, res, gateway, authorizer, artifactId }) {
  const artifact = await findArtifact(gateway, artifactId);
  if (!artifact) {
    return sendJson(res, 404, { error: 'Artifact not found' });
  }
  const job = await gateway.getJob(artifact.jobId);
  if (job) {
    await authorize({ req, authorizer, scope: 'artifacts:read', resource: job });
  }
  if (artifact.downloadUrl) {
    res.writeHead(302, { Location: artifact.downloadUrl });
    return res.end();
  }
  if (!artifact.localPath) {
    const stored = await gateway.readArtifact?.(artifactId);
    if (stored) {
      res.writeHead(200, {
        'Content-Type': stored.artifact.contentType ?? contentTypeForName(stored.artifact.name),
        'Content-Length': stored.content.byteLength,
        'Content-Disposition': `attachment; filename="${safeHeaderFilename(stored.artifact.name)}"`,
      });
      res.end(stored.content);
      return;
    }
    return sendJson(res, 501, { error: 'Artifact download is not configured for this backend' });
  }

  const artifactStat = await stat(artifact.localPath);
  res.writeHead(200, {
    'Content-Type': contentTypeForName(artifact.name),
    'Content-Length': artifactStat.size,
    'Content-Disposition': `attachment; filename="${safeHeaderFilename(artifact.name)}"`,
  });
  return createReadStream(artifact.localPath).pipe(res);
}

async function authorize({ req, authorizer, scope, body, resource }) {
  return authorizer.authorize({
    headers: req.headers,
    scope,
    tenantId: body?.tenantId ?? resource?.tenantId,
    projectId: body?.projectId ?? resource?.projectId,
  });
}

function withAuthContext(request, auth) {
  return {
    ...request,
    actor: auth.actor,
    metadata: {
      ...(request.metadata ?? {}),
      gatewayAuth: {
        tokenRef: auth.tokenRef,
        actor: auth.actor,
      },
    },
  };
}

async function findArtifact(gateway, artifactId) {
  if (gateway.getArtifact) {
    return gateway.getArtifact(artifactId);
  }
  return null;
}

async function waitForJobId({ gateway, events, completion, requestedJobId = null }) {
  for (let index = 0; index < 20; index += 1) {
    const queued = events.find((event) => event.jobId);
    const candidate = requestedJobId ?? queued?.jobId;
    if (candidate && await gateway.getJob(candidate)) {
      return candidate;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const result = await completion;
  return result?.id;
}

async function readJson(req, { allowEmpty = false } = {}) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw && allowEmpty) {
    return {};
  }
  if (!raw) {
    throw Object.assign(new Error('Request body must be JSON'), { statusCode: 400 });
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('Invalid JSON request body'), { statusCode: 400 });
  }
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
  });
  res.end(JSON.stringify(payload));
}

function sanitizeSession(session) {
  if (!session) {
    return null;
  }
  const { workspacePath, ...publicSession } = session;
  return publicSession;
}

function sanitizeJob(job) {
  if (!job) {
    return null;
  }
  return { ...job };
}

function sanitizeArtifact(artifact) {
  const { localPath, ...publicArtifact } = artifact;
  return publicArtifact;
}

function parseLastEventId(value) {
  if (Array.isArray(value)) {
    return parseLastEventId(value.at(-1));
  }
  const parsed = Number.parseInt(value ?? '0', 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function singleHeader(value, name) {
  if (Array.isArray(value)) {
    throw Object.assign(new Error(`${name} must be provided only once`), { statusCode: 400 });
  }
  return value ?? null;
}

function statusForError(error) {
  if (Number.isInteger(error?.statusCode)) {
    return error.statusCode;
  }
  if (error instanceof TypeError) {
    return 400;
  }
  if (/not found/i.test(error?.message ?? '')) {
    return 404;
  }
  return 500;
}

function contentTypeForName(name = '') {
  switch (extname(name).toLowerCase()) {
    case '.json':
      return 'application/json';
    case '.txt':
    case '.log':
      return 'text/plain; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}

function safeHeaderFilename(name = 'artifact') {
  return name.replaceAll(/["\r\n]/g, '_');
}

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

async function handleUpgrade({ req, socket, head, gateway, authorizer, logger }) {
  const url = new URL(req.url, 'http://localhost');
  const segments = url.pathname.split('/').filter(Boolean);

  // Upgrade route pattern: /v1/sessions/:sessionId/pty or /v1/sessions/:sessionId/shell
  if (segments[0] !== 'v1' || segments[1] !== 'sessions' || !segments[2] || (segments[3] !== 'pty' && segments[3] !== 'shell')) {
    const error = new Error('Upgrade route not found');
    error.statusCode = 404;
    throw error;
  }

  const sessionId = segments[2];
  const session = await gateway.getSession(sessionId);
  if (!session) {
    const error = new Error('Session not found');
    error.statusCode = 404;
    throw error;
  }

  // Authorize with sessions:shell scope
  await authorize({ req, authorizer, scope: 'sessions:shell', resource: session });

  // Validate WebSocket Upgrade headers
  const upgradeHeader = (req.headers.upgrade || '').toLowerCase();
  const secWebSocketKey = req.headers['sec-websocket-key'];
  if (upgradeHeader !== 'websocket' || !secWebSocketKey) {
    const error = new Error('Bad Request: Invalid WebSocket upgrade headers');
    error.statusCode = 400;
    throw error;
  }

  // Parse terminal query options
  const command = url.searchParams.get('command') || '/bin/sh';
  const cols = Number.parseInt(url.searchParams.get('cols') || '80', 10) || 80;
  const rows = Number.parseInt(url.searchParams.get('rows') || '24', 10) || 24;

  // Complete WebSocket 101 Handshake
  const acceptKey = createHash('sha1').update(secWebSocketKey + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${acceptKey}\r\n\r\n`
  );

  const ws = new WebSocketStream(socket, { isServer: true, head });

  // Initialize PTY session via gateway
  let pty;
  try {
    pty = await gateway.createSessionPty(sessionId, { command, cols, rows });
  } catch (err) {
    logger?.error?.('Failed to spawn PTY session:', err);
    ws.send(JSON.stringify({ type: 'error', error: err.message ?? 'Failed to spawn PTY' }));
    ws.close(1011, 'PTY initialization failed');
    return;
  }

  // Forward PTY output to WebSocket
  pty.on('data', (chunk) => {
    ws.send(chunk.toString('utf8'));
  });

  const pendingWrites = [];
  let ptyReady = Boolean(pty.isReady);

  pty.on('ready', () => {
    ptyReady = true;
    while (pendingWrites.length > 0) {
      const item = pendingWrites.shift();
      if (item.type === 'stdin') {
        pty.write(item.data);
      } else if (item.type === 'resize') {
        pty.resize(item.cols, item.rows);
      }
    }
  });

  pty.on('close', (exitCode) => {
    try {
      ws.send(JSON.stringify({ type: 'exit', exitCode }));
    } catch {
      // socket may already be closing
    }
    ws.close(1000, `PTY exited with code ${exitCode}`);
  });

  pty.on('error', (err) => {
    logger?.error?.('PTY error:', err);
    try {
      ws.send(JSON.stringify({ type: 'error', error: err.message }));
    } catch {}
    ws.close(1011, 'PTY error');
  });

  // Handle incoming WebSocket messages
  ws.on('message', (data, isBinary) => {
    const text = isBinary ? data.toString('utf8') : String(data);
    // Check if JSON message (resize, ping, stdin command)
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') {
        if (parsed.type === 'resize') {
          const rCols = Number.parseInt(parsed.cols, 10);
          const rRows = Number.parseInt(parsed.rows, 10);
          if (rCols && rRows) {
            if (ptyReady) {
              pty.resize(rCols, rRows);
            } else {
              pendingWrites.push({ type: 'resize', cols: rCols, rows: rRows });
            }
            return;
          }
        }
        if (parsed.type === 'stdin') {
          if (ptyReady) {
            pty.write(parsed.data ?? '');
          } else {
            pendingWrites.push({ type: 'stdin', data: parsed.data ?? '' });
          }
          return;
        }
      }
    } catch {
      // Not a JSON control message, treat raw message as direct stdin keystrokes
    }
    if (ptyReady) {
      pty.write(text);
    } else {
      pendingWrites.push({ type: 'stdin', data: text });
    }
  });

  ws.on('close', () => {
    pty.kill('SIGTERM');
  });

  ws.on('error', (err) => {
    logger?.error?.('WebSocket stream error:', err);
    pty.kill('SIGKILL');
  });
}
