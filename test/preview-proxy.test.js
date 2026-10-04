import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  evaluateEgressPolicy,
  evaluatePreviewPortPolicy,
  proxyPreviewRequest,
} from '../src/gateway/preview-proxy.js';
import { LocalSandboxProvider } from '../src/providers/local-sandbox-provider.js';
import { InMemoryAgentExecutionGateway } from '../src/gateway/in-memory-agent-execution-gateway.js';
import { createAgentExecutionGatewayServer } from '../src/gateway/http-agent-execution-gateway.js';

test('Egress network policy: allowlist, blocklist, and disabled isolation modes', () => {
  // Allowlist mode
  const allowlistPolicy = {
    outbound: 'allowlist',
    allowedHosts: ['api.github.com', '*.npmjs.org'],
    blockedHosts: ['malicious.site'],
  };
  assert.equal(evaluateEgressPolicy('api.github.com', allowlistPolicy).allowed, true);
  assert.equal(evaluateEgressPolicy('registry.npmjs.org', allowlistPolicy).allowed, true);
  assert.equal(evaluateEgressPolicy('google.com', allowlistPolicy).allowed, false);
  assert.equal(evaluateEgressPolicy('malicious.site', allowlistPolicy).allowed, false);

  // Blocklist mode
  const blocklistPolicy = {
    outbound: 'blocklist',
    blockedHosts: ['internal-metadata.aws', '*.secret.internal'],
  };
  assert.equal(evaluateEgressPolicy('google.com', blocklistPolicy).allowed, true);
  assert.equal(evaluateEgressPolicy('internal-metadata.aws', blocklistPolicy).allowed, false);
  assert.equal(evaluateEgressPolicy('db.secret.internal', blocklistPolicy).allowed, false);

  // Disabled mode
  const disabledPolicy = { outbound: 'disabled' };
  assert.equal(evaluateEgressPolicy('api.github.com', disabledPolicy).allowed, false);
});

test('Preview port policy: privileged port protection and allowed previewPorts restriction', () => {
  // Privileged port blocked
  assert.equal(evaluatePreviewPortPolicy(22).allowed, false);
  assert.equal(evaluatePreviewPortPolicy(80).allowed, false);

  // Default allowed dev ports
  assert.equal(evaluatePreviewPortPolicy(3000).allowed, true);
  assert.equal(evaluatePreviewPortPolicy(5173).allowed, true);

  // Explicit session restriction
  const sessionWithPorts = {
    network: { previewPorts: [3000, 8080] },
  };
  assert.equal(evaluatePreviewPortPolicy(3000, sessionWithPorts).allowed, true);
  assert.equal(evaluatePreviewPortPolicy(5173, sessionWithPorts).allowed, false);
});

test('HTTP gateway: /preview/:sessionId/:port/* proxies request to target app and returns response', async () => {
  // 1. Start a mock upstream server (e.g. Vite or Next.js app in sandbox)
  let receivedHeaders = null;
  const upstream = http.createServer((req, res) => {
    receivedHeaders = req.headers;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<h1>Hello from Sandbox Dev Server at ${req.url}</h1>`);
  });

  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = upstream.address().port;

  // 2. Setup gateway server
  const provider = new LocalSandboxProvider();
  const session = await provider.createSession({
    id: 'ses_preview_test',
    sandbox: {},
  });
  const gateway = new InMemoryAgentExecutionGateway({ provider });
  const app = createAgentExecutionGatewayServer({ gateway });

  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const gatewayPort = app.server.address().port;
  const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;

  try {
    // 3. Make request to preview proxy
    const res = await fetch(`${gatewayUrl}/preview/ses_preview_test/${upstreamPort}/index.html?token=test`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.ok(body.includes('<h1>Hello from Sandbox Dev Server at /index.html?token=test</h1>'));

    // Check forwarded headers
    assert.equal(receivedHeaders['x-partners-session-id'], 'ses_preview_test');
    assert.equal(receivedHeaders['x-partners-preview-port'], String(upstreamPort));

    // 4. Test port restriction rejection
    const resRestricted = await fetch(`${gatewayUrl}/preview/ses_preview_test/22/ssh`);
    assert.equal(resRestricted.status, 403);

    // 5. Non-existent session
    const resNotFound = await fetch(`${gatewayUrl}/preview/ses_nonexistent/${upstreamPort}/`);
    assert.equal(resNotFound.status, 404);
  } finally {
    await app.close();
    await new Promise((resolve) => upstream.close(resolve));
    await provider.deleteSession(session.id);
  }
});
