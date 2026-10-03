import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';

import { createConsoleServer } from '../console/server.mjs';

test('Console server serves health, config, and static assets', async () => {
  // Mock gateway for proxy test
  const mockGateway = http.createServer((req, res) => {
    if (req.url === '/v1/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'gateway_ok' }));
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => mockGateway.listen(0, resolve));
  const gatewayPort = mockGateway.address().port;
  const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;

  const consoleInstance = createConsoleServer({
    gatewayUrl,
  });
  await new Promise((resolve) => consoleInstance.listen(0, resolve));
  const consolePort = consoleInstance.server.address().port;
  const consoleBaseUrl = `http://127.0.0.1:${consolePort}`;

  try {
    // 1. /health
    const healthRes = await fetch(`${consoleBaseUrl}/health`);
    assert.equal(healthRes.status, 200);
    const healthData = await healthRes.json();
    assert.equal(healthData.status, 'ok');
    assert.equal(healthData.component, 'partners-console');

    // 2. /api/config
    const configRes = await fetch(`${consoleBaseUrl}/api/config`);
    assert.equal(configRes.status, 200);
    const configData = await configRes.json();
    assert.equal(configData.gatewayUrl, gatewayUrl);

    // 3. Static files: index.html
    const indexRes = await fetch(`${consoleBaseUrl}/`);
    assert.equal(indexRes.status, 200);
    assert.match(indexRes.headers.get('content-type'), /text\/html/);
    const indexText = await indexRes.text();
    assert.match(indexText, /Partners Admin Console/);

    // 4. Static files: style.css
    const cssRes = await fetch(`${consoleBaseUrl}/style.css`);
    assert.equal(cssRes.status, 200);
    assert.match(cssRes.headers.get('content-type'), /text\/css/);

    // 5. Static files: app.js
    const jsRes = await fetch(`${consoleBaseUrl}/app.js`);
    assert.equal(jsRes.status, 200);
    assert.match(jsRes.headers.get('content-type'), /application\/javascript/);

    // 6. /api/proxy/v1/health -> proxies to mockGateway /v1/health
    const proxyRes = await fetch(`${consoleBaseUrl}/api/proxy/v1/health`);
    assert.equal(proxyRes.status, 200);
    const proxyData = await proxyRes.json();
    assert.equal(proxyData.status, 'gateway_ok');
  } finally {
    await consoleInstance.close();
    await new Promise((resolve) => mockGateway.close(resolve));
  }
});
