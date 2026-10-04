import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createAgentExecutionGatewayServer,
  GatewayServiceAuthorizer,
  InMemoryAgentExecutionGateway,
  InMemoryGatewayStore,
  LocalSandboxProvider,
  PtySession,
  WebSocketStream,
  connectClientWebSocket,
} from '../src/index.js';

test('WebSocketStream frames, sends, and parses messages correctly', async () => {
  const { createServer } = await import('node:net');
  let serverWs = null;
  const receivedMessages = [];

  const tcpServer = createServer((socket) => {
    serverWs = new WebSocketStream(socket, { isServer: true });
    serverWs.on('message', (msg) => {
      receivedMessages.push(msg);
      serverWs.send(`ack: ${msg}`);
    });
  });

  await new Promise((resolve) => tcpServer.listen(0, '127.0.0.1', resolve));
  const { port } = tcpServer.address();

  const { Socket } = await import('node:net');
  const clientSocket = new Socket();
  await new Promise((resolve) => clientSocket.connect(port, '127.0.0.1', resolve));

  const clientWs = new WebSocketStream(clientSocket, { isServer: false });
  const clientReceived = [];
  clientWs.on('message', (msg) => {
    clientReceived.push(msg);
  });

  clientWs.send('hello world');
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(receivedMessages.length, 1);
  assert.equal(receivedMessages[0], 'hello world');
  assert.equal(clientReceived.length, 1);
  assert.equal(clientReceived[0], 'ack: hello world');

  clientWs.close();
  await new Promise((resolve) => tcpServer.close(resolve));
});

test('PtySession spawns shell and executes interactive command', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pty-test-'));
  try {
    const pty = new PtySession({
      cwd: dir,
      command: '/bin/sh',
    });

    let output = '';
    pty.on('data', (chunk) => {
      output += chunk.toString('utf8');
    });

    await new Promise((resolve) => {
      pty.on('ready', () => {
        pty.write('echo "PTY_TEST_LINE"\nexit\n');
      });
      pty.on('close', resolve);
    });

    assert.ok(output.includes('PTY_TEST_LINE'), `Expected PTY_TEST_LINE in output, got: ${output}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('HTTP Gateway exposes WebSocket PTY terminal at /v1/sessions/:id/pty', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gw-pty-test-'));
  const store = new InMemoryGatewayStore();
  const provider = new LocalSandboxProvider({ rootDir: dir });
  const gateway = new InMemoryAgentExecutionGateway({ provider, store });
  const app = createAgentExecutionGatewayServer({ gateway });

  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const { port } = app.server.address();

  try {
    // 1. Create a workspace session
    const createRes = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'ses_pty_test' }),
    });
    assert.equal(createRes.status, 202);

    // 2. Query PTY endpoint via POST
    const ptyPostRes = await fetch(`http://127.0.0.1:${port}/v1/sessions/ses_pty_test/pty`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cols: 100, rows: 30 }),
    });
    assert.equal(ptyPostRes.status, 200);
    const ptyMeta = await ptyPostRes.json();
    assert.equal(ptyMeta.sessionId, 'ses_pty_test');
    assert.ok(ptyMeta.wsUrl.includes('/v1/sessions/ses_pty_test/pty'));
    assert.equal(ptyMeta.cols, 100);
    assert.equal(ptyMeta.rows, 30);

    // 3. Connect via WebSocket to /v1/sessions/:id/pty
    const ws = await connectClientWebSocket(`ws://127.0.0.1:${port}/v1/sessions/ses_pty_test/pty?cols=80&rows=24`);
    let terminalOutput = '';

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timeout waiting for PTY output, received: ${terminalOutput}`)), 10000);
      ws.on('message', (data) => {
        terminalOutput += data.toString();
        if (terminalOutput.includes('INTERACTIVE_PTY_OK')) {
          clearTimeout(timer);
          ws.close();
          resolve();
        }
      });
      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      // Send resize control frame
      ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
      // Send command through JSON stdin
      ws.send(JSON.stringify({ type: 'stdin', data: 'echo "INTERACTIVE_PTY_OK"\nexit\n' }));
    });

    assert.ok(terminalOutput.includes('INTERACTIVE_PTY_OK'));
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('HTTP Gateway enforces sessions:shell authorization for WebSocket PTY', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gw-auth-pty-test-'));
  const store = new InMemoryGatewayStore();
  const provider = new LocalSandboxProvider({ rootDir: dir });
  const gateway = new InMemoryAgentExecutionGateway({ provider, store });
  const authorizer = new GatewayServiceAuthorizer({
    tokens: [
      {
        token: 'read-only-token',
        scopes: ['sessions:read'],
      },
      {
        token: 'shell-token',
        scopes: ['sessions:shell', 'sessions:create', 'sessions:read'],
      },
    ],
  });
  const app = createAgentExecutionGatewayServer({ gateway, authorizer });

  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const { port } = app.server.address();

  try {
    // Create session using shell-token
    const createRes = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer shell-token',
      },
      body: JSON.stringify({ id: 'ses_auth_pty' }),
    });
    assert.equal(createRes.status, 202);

    // Unauthorized WebSocket connection without token should fail
    await assert.rejects(async () => {
      await connectClientWebSocket(`ws://127.0.0.1:${port}/v1/sessions/ses_auth_pty/pty`);
    });

    // Unauthorized WebSocket connection with read-only token should fail
    await assert.rejects(async () => {
      await connectClientWebSocket(`ws://127.0.0.1:${port}/v1/sessions/ses_auth_pty/pty`, {
        headers: { Authorization: 'Bearer read-only-token' },
      });
    });

    // Authorized WebSocket connection with shell-token succeeds
    const ws = await connectClientWebSocket(`ws://127.0.0.1:${port}/v1/sessions/ses_auth_pty/pty`, {
      headers: { Authorization: 'Bearer shell-token' },
    });
    let received = '';
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout waiting for auth PTY')), 5000);
      ws.on('message', (data) => {
        received += data.toString();
        if (received.includes('AUTH_SHELL_OK')) {
          clearTimeout(timer);
          ws.close();
          resolve();
        }
      });
      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      ws.send('echo "AUTH_SHELL_OK"\nexit\n');
    });

    assert.ok(received.includes('AUTH_SHELL_OK'));
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
