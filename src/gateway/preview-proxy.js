import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

/**
 * Validates whether an egress target host or IP is allowed under outbound network policy.
 *
 * @param {string} targetHost - Hostname or IP string
 * @param {Object} [networkPolicy] - Sandbox network policy
 * @param {string} [networkPolicy.outbound] - 'allowlist' | 'blocklist' | 'open' | 'disabled'
 * @param {string[]} [networkPolicy.allowedHosts] - Allowlisted hostnames/patterns
 * @param {string[]} [networkPolicy.blockedHosts] - Blocklisted hostnames/patterns
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function evaluateEgressPolicy(targetHost, networkPolicy = {}) {
  const outbound = networkPolicy.outbound ?? 'allowlist';
  const allowedHosts = networkPolicy.allowedHosts ?? [];
  const blockedHosts = networkPolicy.blockedHosts ?? [];

  if (outbound === 'disabled') {
    return { allowed: false, reason: 'Outbound network access is disabled' };
  }

  // Check blocked hosts first (in both blocklist and allowlist modes)
  const host = targetHost.toLowerCase().trim();
  const isBlocked = blockedHosts.some((pattern) => matchesHostPattern(host, pattern.toLowerCase()));
  if (isBlocked) {
    return { allowed: false, reason: `Host '${host}' is blocked by egress network policy` };
  }

  if (outbound === 'open') {
    return { allowed: true };
  }

  if (outbound === 'blocklist') {
    return { allowed: true };
  }

  // outbound === 'allowlist'
  const isAllowed = allowedHosts.some((pattern) => matchesHostPattern(host, pattern.toLowerCase()));
  if (!isAllowed) {
    return { allowed: false, reason: `Host '${host}' is not in the allowed outbound hosts` };
  }

  return { allowed: true };
}

function matchesHostPattern(host, pattern) {
  if (pattern === '*' || pattern === host) return true;
  if (pattern.startsWith('*.')) {
    const domain = pattern.slice(2);
    return host.endsWith(domain) || host === domain;
  }
  return false;
}

/**
 * Evaluates whether previewing a given port for a session is allowed.
 *
 * @param {number} port
 * @param {Object} session
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function evaluatePreviewPortPolicy(port, session = {}) {
  const previewPorts = session.network?.previewPorts ?? session.sandbox?.network?.previewPorts ?? [];

  // Default allowed preview ports if not specified: common dev ports (3000-9999)
  // Protected system ports (< 1024) are blocked unless explicitly authorized
  if (port < 1 || port > 65535) {
    return { allowed: false, reason: `Invalid port number: ${port}` };
  }

  if (port < 1024) {
    return { allowed: false, reason: `Privileged ports (< 1024) are not allowed for preview: ${port}` };
  }

  if (Array.isArray(previewPorts) && previewPorts.length > 0) {
    if (!previewPorts.includes(port)) {
      return { allowed: false, reason: `Port ${port} is not in session allowed previewPorts [${previewPorts.join(', ')}]` };
    }
  }

  return { allowed: true };
}

/**
 * Handles reverse proxying from gateway /preview/:sessionId/:port/* to local or remote target
 */
export async function proxyPreviewRequest({
  req,
  res,
  sessionId,
  port,
  subpath,
  targetHost = '127.0.0.1',
  session = null,
}) {
  const portNum = Number.parseInt(port, 10);
  if (Number.isNaN(portNum)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: `Invalid port: ${port}` }));
  }

  const portCheck = evaluatePreviewPortPolicy(portNum, session ?? {});
  if (!portCheck.allowed) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: portCheck.reason }));
  }

  // Resolve target url
  const targetPath = subpath.startsWith('/') ? subpath : `/${subpath}`;
  const incomingUrl = new URL(req.url, 'http://localhost');
  const fullTargetUrl = `${targetPath}${incomingUrl.search}`;

  const forwardHeaders = { ...req.headers };
  forwardHeaders.host = `${targetHost}:${portNum}`;
  forwardHeaders['x-forwarded-for'] = req.socket?.remoteAddress ?? '127.0.0.1';
  forwardHeaders['x-forwarded-proto'] = 'http';
  forwardHeaders['x-partners-session-id'] = sessionId;
  forwardHeaders['x-partners-preview-port'] = String(portNum);

  const proxyReq = http.request(
    {
      hostname: targetHost,
      port: portNum,
      path: fullTargetUrl,
      method: req.method,
      headers: forwardHeaders,
      timeout: 10000,
    },
    (proxyRes) => {
      // Forward response headers
      const resHeaders = { ...proxyRes.headers };
      // Prevent cache confusion on preview endpoints
      resHeaders['x-content-type-options'] = 'nosniff';
      res.writeHead(proxyRes.statusCode ?? 200, resHeaders);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: `Bad Gateway: Unable to connect to sandbox preview on port ${portNum}`,
        details: err.message,
      }));
    }
  });

  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    if (!res.headersSent) {
      res.writeHead(504, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: `Gateway Timeout: Preview target on port ${portNum} did not respond within timeout`,
      }));
    }
  });

  req.pipe(proxyReq);
}
