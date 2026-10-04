import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = resolve(__dirname, 'public');

export function createConsoleServer({
  gatewayUrl = process.env.PARTNERS_GATEWAY_URL || process.env.GATEWAY_URL || 'http://localhost:8080',
  port = Number.parseInt(process.env.CONSOLE_PORT || '3000', 10),
  host = process.env.CONSOLE_HOST || '0.0.0.0',
} = {}) {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key, Last-Event-ID');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    // Health check
    if (pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ok', component: 'partners-console' }));
    }

    // Config endpoint
    if (pathname === '/api/config') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        gatewayUrl,
      }));
    }

    // Proxy endpoint: /api/proxy/v1/... -> forward to gatewayUrl
    if (pathname.startsWith('/api/proxy/')) {
      const targetPath = pathname.slice('/api/proxy'.length) + url.search;
      const targetUrl = new URL(targetPath, gatewayUrl);

      try {
        const headers = { ...req.headers };
        delete headers.host;

        const proxyReq = http.request(targetUrl, {
          method: req.method,
          headers,
        }, (proxyRes) => {
          res.writeHead(proxyRes.statusCode, proxyRes.headers);
          proxyRes.pipe(res);
        });

        proxyReq.on('error', (err) => {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Proxy to gateway failed: ${err.message}` }));
        });

        req.pipe(proxyReq);
        return;
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: error.message }));
      }
    }

    // Direct preview proxy: /preview/:sessionId/:port/* -> forward to gatewayUrl/preview/...
    if (pathname.startsWith('/preview/')) {
      const targetUrl = new URL(pathname + url.search, gatewayUrl);
      try {
        const headers = { ...req.headers };
        delete headers.host;

        const proxyReq = http.request(targetUrl, {
          method: req.method,
          headers,
        }, (proxyRes) => {
          res.writeHead(proxyRes.statusCode, proxyRes.headers);
          proxyRes.pipe(res);
        });

        proxyReq.on('error', (err) => {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Preview proxy to gateway failed: ${err.message}` }));
        });

        req.pipe(proxyReq);
        return;
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: error.message }));
      }
    }

    // Static files
    try {
      const sanitized = pathname === '/' ? '/index.html' : pathname;
      const safePath = join(PUBLIC_DIR, sanitized.replace(/^(\.\.[\/\\])+/, ''));
      if (!safePath.startsWith(PUBLIC_DIR)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        return res.end('Forbidden');
      }

      try {
        const fileStat = await stat(safePath);
        if (fileStat.isFile()) {
          const ext = extname(safePath).toLowerCase();
          const contentType = MIME_TYPES[ext] || 'application/octet-stream';
          res.writeHead(200, {
            'Content-Type': contentType,
            'Content-Length': fileStat.size,
          });
          return createReadStream(safePath).pipe(res);
        }
      } catch {
        // Fallback to index.html for SPA client-side routes
        const indexPath = join(PUBLIC_DIR, 'index.html');
        const indexStat = await stat(indexPath);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': indexStat.size,
        });
        return createReadStream(indexPath).pipe(res);
      }
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Internal server error: ${err.message}`);
    }
  });

  server.on('upgrade', (req, clientSocket, head) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    let targetPath = url.pathname + url.search;
    if (targetPath.startsWith('/api/proxy/')) {
      targetPath = targetPath.slice('/api/proxy'.length);
    }
    const targetUrl = new URL(targetPath, gatewayUrl);

    const proxyReq = http.request(targetUrl, {
      method: req.method,
      headers: { ...req.headers, host: targetUrl.host },
    });

    proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
      clientSocket.write(
        `HTTP/1.1 101 Switching Protocols\r\n` +
        Object.entries(proxyRes.headers)
          .map(([k, v]) => `${k}: ${v}\r\n`)
          .join('') +
        '\r\n'
      );
      if (proxyHead && proxyHead.length) clientSocket.write(proxyHead);
      if (head && head.length) proxySocket.write(head);
      proxySocket.pipe(clientSocket);
      clientSocket.pipe(proxySocket);
    });

    proxyReq.on('error', (err) => {
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      clientSocket.destroy();
    });

    proxyReq.end();
  });

  return {
    server,
    listen: (customPort, customHost) => server.listen(customPort ?? port, customHost ?? host),
    close: () => new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }),
  };
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const port = Number.parseInt(process.env.CONSOLE_PORT || '3000', 10);
  const host = process.env.CONSOLE_HOST || '0.0.0.0';
  const instance = createConsoleServer({ port, host });
  instance.listen(port, host);
  console.log(`[Partners Console] Listening on http://${host}:${port}`);
}
