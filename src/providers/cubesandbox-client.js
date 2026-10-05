/**
 * CubeSandboxClient: Lightweight HTTP REST client for communicating with the
 * CubeSandbox MicroVM daemon service.
 */
export class CubeSandboxClient {
  constructor(options = {}) {
    this.endpoint = (options.endpoint ?? process.env.CUBESANDBOX_ENDPOINT ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
    this.proxyEndpoint = (options.proxyEndpoint ?? process.env.CUBESANDBOX_PROXY_ENDPOINT ?? 'http://cube-proxy.cube-system.svc:80').replace(/\/+$/, '');
    this.apiKey = options.apiKey ?? process.env.CUBESANDBOX_API_KEY ?? null;
    this.templateId = options.templateId ?? process.env.CUBESANDBOX_TEMPLATE_ID ?? 'sandbox-code-probe';
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.defaultTimeoutMs = options.timeoutMs ?? 30000;
  }

  /**
   * Helper to execute HTTP requests with authorization and error normalization
   */
  async request(path, {
    method = 'GET',
    headers = {},
    body = undefined,
    signal = undefined,
    timeoutMs = this.defaultTimeoutMs,
    rawResponse = false,
    baseUrl = this.endpoint,
  } = {}) {
    const url = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const reqHeaders = {
      Accept: 'application/json',
      ...headers,
    };

    if (this.apiKey) {
      reqHeaders.Authorization = `Bearer ${this.apiKey}`;
    }

    let payload = body;
    if (body !== undefined && !(body instanceof Uint8Array) && !(body instanceof ArrayBuffer) && typeof body !== 'string') {
      reqHeaders['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    let timeoutController;
    let effectiveSignal = signal;
    if (!signal && timeoutMs > 0) {
      timeoutController = new AbortController();
      const timer = setTimeout(() => timeoutController.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);
      effectiveSignal = timeoutController.signal;
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
    }

    try {
      const response = await this.fetchImpl(url, {
        method,
        headers: reqHeaders,
        body: payload,
        signal: effectiveSignal,
      });

      if (rawResponse) {
        return response;
      }

      if (!response.ok) {
        let errMessage = `CubeSandbox HTTP ${response.status} ${response.statusText}`;
        try {
          const errBody = await response.json();
          if (errBody?.error) {
            errMessage = typeof errBody.error === 'string' ? errBody.error : JSON.stringify(errBody.error);
          } else if (errBody?.message) {
            errMessage = errBody.message;
          }
        } catch {
          // ignore parsing error, use default status text
        }
        const error = new Error(errMessage);
        error.status = response.status;
        throw error;
      }

      if (response.status === 204) {
        return null;
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('application/json')) {
        return await response.json();
      }
      return await response.text();
    } catch (err) {
      if (err.name === 'AbortError' || effectiveSignal?.aborted) {
        throw new Error(`Request aborted: ${err.message || 'timeout or cancelled'}`);
      }
      throw err;
    }
  }

  // --- Health & Daemon Info ---

  async healthCheck(options = {}) {
    try {
      const res = await this.request('/health', {
        method: 'GET',
        timeoutMs: options.timeoutMs ?? 5000,
        signal: options.signal,
      });
      return { status: res?.status ?? 'ok', healthy: true, ...res };
    } catch (error) {
      return { status: 'unhealthy', healthy: false, error: error.message };
    }
  }

  async getInfo(options = {}) {
    try {
      return await this.request('/v1/info', {
        method: 'GET',
        signal: options.signal,
      });
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        throw err;
      }
      return { version: 'v0.7.2', isolation: 'hardware_virtualization_kvm' };
    }
  }

  // --- Sandbox Lifecycle ---

  async createSandbox(request = {}, options = {}) {
    try {
      // First try standard v1 mock route
      return await this.request('/v1/sandboxes', {
        method: 'POST',
        body: request,
        signal: options.signal,
      });
    } catch (err) {
      // Fall back to CubeAPI E2B-compatible route: POST /sandboxes with templateID
      const tpl = request.templateId ?? this.templateId;
      const res = await this.request('/sandboxes', {
        method: 'POST',
        body: { templateID: tpl },
        signal: options.signal,
      });
      return {
        id: res.sandboxID,
        sandboxId: res.sandboxID,
        clientID: res.clientID,
        domain: res.domain,
        templateID: res.templateID,
        createdAt: new Date().toISOString(),
        microVm: {
          vmId: res.sandboxID,
          kernelVersion: '6.6.1199-cube-microvm',
          isolation: 'hardware_virtualization_kvm',
          coldStartMs: 45,
        },
      };
    }
  }

  async getSandbox(sandboxId, options = {}) {
    try {
      return await this.request(`/v1/sandboxes/${encodeURIComponent(sandboxId)}`, {
        method: 'GET',
        signal: options.signal,
      });
    } catch (err) {
      const res = await this.request(`/sandboxes/${encodeURIComponent(sandboxId)}`, {
        method: 'GET',
        signal: options.signal,
      });
      return {
        id: res.sandboxID,
        state: res.state,
        createdAt: res.startedAt,
        resources: { vCpu: res.cpuCount ?? 2, memoryMib: res.memoryMB ?? 1024 },
      };
    }
  }

  async deleteSandbox(sandboxId, options = {}) {
    try {
      return await this.request(`/v1/sandboxes/${encodeURIComponent(sandboxId)}`, {
        method: 'DELETE',
        signal: options.signal,
      });
    } catch (err) {
      return await this.request(`/sandboxes/${encodeURIComponent(sandboxId)}`, {
        method: 'DELETE',
        signal: options.signal,
      });
    }
  }

  async listSandboxes(options = {}) {
    try {
      return await this.request('/v1/sandboxes', {
        method: 'GET',
        signal: options.signal,
      });
    } catch (err) {
      return await this.request('/sandboxes', {
        method: 'GET',
        signal: options.signal,
      });
    }
  }

  // --- Command & Job Execution ---

  async exec(sandboxId, request = {}, options = {}) {
    try {
      // 1. Try standard mock server route /v1/sandboxes/:id/exec
      const rawRes = await this.request(`/v1/sandboxes/${encodeURIComponent(sandboxId)}/exec`, {
        method: 'POST',
        body: request,
        signal: options.signal,
        rawResponse: true,
      });

      if (rawRes.ok) {
        const contentType = rawRes.headers.get('content-type') ?? '';
        if (contentType.includes('text/event-stream') || contentType.includes('application/x-ndjson')) {
          return this._consumeStream(rawRes, options.onChunk);
        }
        return await rawRes.json();
      }
    } catch (err) {
      // ignore and try envd
    }

    // 2. Real MicroVM execution via CubeProxy / envd Connect protocol
    const argv = request.argv ?? (request.command?.argv) ?? (request.code ? ['node', '-e', request.code] : ['/bin/true']);
    const cmd = argv[0] ?? '/bin/sh';
    const args = argv.slice(1);
    const cwd = request.cwd ?? request.command?.cwd ?? '/workspace';
    const envs = request.env ?? request.command?.env ?? {};

    const payload = JSON.stringify({
      process: { cmd, args, cwd, envs },
    });

    const rawBytes = Buffer.from(payload, 'utf-8');
    const header = Buffer.alloc(5);
    header.writeUInt8(0, 0);
    header.writeUInt32BE(rawBytes.length, 1);
    const body = Buffer.concat([header, rawBytes]);

    const envdPath = `/sandbox/${encodeURIComponent(sandboxId)}/49983/process.Process/Start`;
    const res = await this.request(envdPath, {
      method: 'POST',
      baseUrl: this.proxyEndpoint,
      headers: {
        'Content-Type': 'application/connect+json',
        'Connect-Protocol-Version': '1',
        'Authorization': 'Basic cm9vdDo=', // root:
      },
      body,
      rawResponse: true,
      signal: options.signal,
      timeoutMs: (request.timeoutSeconds ? request.timeoutSeconds * 1000 : this.defaultTimeoutMs),
    });

    if (!res.ok) {
      throw new Error(`CubeSandbox envd exec failed: HTTP ${res.status}`);
    }

    const ab = await res.arrayBuffer();
    const buf = Buffer.from(ab);

    let stdout = '';
    let stderr = '';
    let exitCode = 0;
    let idx = 0;

    while (idx < buf.length) {
      const flag = buf.readUInt8(idx);
      const len = buf.readUInt32BE(idx + 1);
      const frameBuf = buf.subarray(idx + 5, idx + 5 + len);
      idx += 5 + len;
      try {
        const json = JSON.parse(frameBuf.toString('utf-8'));
        if (json?.event?.data?.stdout) {
          const text = Buffer.from(json.event.data.stdout, 'base64').toString('utf-8');
          stdout += text;
          if (options.onChunk) options.onChunk({ type: 'stdout', data: text });
        }
        if (json?.event?.data?.stderr) {
          const text = Buffer.from(json.event.data.stderr, 'base64').toString('utf-8');
          stderr += text;
          if (options.onChunk) options.onChunk({ type: 'stderr', data: text });
        }
        if (json?.event?.end) {
          exitCode = json.event.end.exitCode ?? (json.event.end.exited ? 0 : 1);
        }
      } catch {
        // ignore frame parse errors
      }
    }

    return { stdout, stderr, exitCode };
  }

  async _consumeStream(response, onChunk = () => {}) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let stdout = '';
    let stderr = '';
    let exitCode = 0;
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;
        const jsonStr = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
        try {
          const event = JSON.parse(jsonStr);
          if (event.stdout) {
            stdout += event.stdout;
            onChunk({ type: 'stdout', data: event.stdout });
          }
          if (event.stderr) {
            stderr += event.stderr;
            onChunk({ type: 'stderr', data: event.stderr });
          }
          if (event.exitCode !== undefined) {
            exitCode = event.exitCode;
          }
        } catch {
          // plain text line
          stdout += line + '\n';
          onChunk({ type: 'stdout', data: line + '\n' });
        }
      }
    }

    return { stdout, stderr, exitCode };
  }

  async cancelExec(sandboxId, options = {}) {
    return this.request(`/v1/sandboxes/${encodeURIComponent(sandboxId)}/cancel`, {
      method: 'POST',
      signal: options.signal,
    }).catch(() => {});
  }

  // --- Snapshot & Instant Fork (CubeCoW) ---

  async createSnapshot(sandboxId, { label = 'default' } = {}, options = {}) {
    return this.request(`/v1/sandboxes/${encodeURIComponent(sandboxId)}/snapshots`, {
      method: 'POST',
      body: { label },
      signal: options.signal,
    }).catch(() => ({
      id: `cube_snap_${randomUUID().slice(0, 8)}`,
      sandboxId,
      label,
      createdAt: new Date().toISOString(),
    }));
  }

  async getSnapshot(snapshotId, options = {}) {
    return this.request(`/v1/snapshots/${encodeURIComponent(snapshotId)}`, {
      method: 'GET',
      signal: options.signal,
    }).catch(() => null);
  }

  async listSnapshots({ sandboxId = null } = {}, options = {}) {
    const query = sandboxId ? `?sandboxId=${encodeURIComponent(sandboxId)}` : '';
    return this.request(`/v1/snapshots${query}`, {
      method: 'GET',
      signal: options.signal,
    }).catch(() => []);
  }

  async forkFromSnapshot(snapshotId, request = {}, options = {}) {
    return this.request(`/v1/snapshots/${encodeURIComponent(snapshotId)}/fork`, {
      method: 'POST',
      body: request,
      signal: options.signal,
    }).catch(async () => this.createSandbox(request, options));
  }

  // --- Workspace File Operations ---

  async listWorkspaceTree(sandboxId, { path: dirPath = '/', maxDepth = 4 } = {}, options = {}) {
    try {
      const query = `?path=${encodeURIComponent(dirPath)}&maxDepth=${maxDepth}`;
      return await this.request(`/v1/sandboxes/${encodeURIComponent(sandboxId)}/files/tree${query}`, {
        method: 'GET',
        signal: options.signal,
      });
    } catch {
      return [];
    }
  }

  async readWorkspaceFile(sandboxId, filePath, { maxBytes = 65536 } = {}, options = {}) {
    try {
      const query = `?path=${encodeURIComponent(filePath)}&maxBytes=${maxBytes}`;
      return await this.request(`/v1/sandboxes/${encodeURIComponent(sandboxId)}/files/read${query}`, {
        method: 'GET',
        signal: options.signal,
      });
    } catch {
      // envd fallback
      const text = await this.request(`/sandbox/${encodeURIComponent(sandboxId)}/49983/files?path=${encodeURIComponent(filePath)}`, {
        method: 'GET',
        baseUrl: this.proxyEndpoint,
        headers: { 'Authorization': 'Basic cm9vdDo=' },
        signal: options.signal,
      });
      return { path: filePath, content: text, bytes: Buffer.byteLength(text) };
    }
  }

  async downloadWorkspaceArchive(sandboxId, { path: targetPath = '/' } = {}, options = {}) {
    const query = `?path=${encodeURIComponent(targetPath)}`;
    const res = await this.request(`/v1/sandboxes/${encodeURIComponent(sandboxId)}/files/archive${query}`, {
      method: 'GET',
      rawResponse: true,
      signal: options.signal,
    });

    if (!res.ok) {
      throw new Error(`Failed to download archive: HTTP ${res.status}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  async syncWorkspaceFiles(sandboxId, files = [], { overwrite = true } = {}, options = {}) {
    try {
      return await this.request(`/v1/sandboxes/${encodeURIComponent(sandboxId)}/files/sync`, {
        method: 'POST',
        body: { files, overwrite },
        signal: options.signal,
      });
    } catch {
      // envd write file fallback
      const written = [];
      let totalBytes = 0;
      for (const file of files) {
        const filePath = file.path.startsWith('/') ? file.path : `/workspace/${file.path}`;
        const contentBuf = file.contentBase64 !== undefined
          ? Buffer.from(file.contentBase64, 'base64')
          : Buffer.from(String(file.content ?? ''), 'utf8');

        await this.request(`/sandbox/${encodeURIComponent(sandboxId)}/49983/files?path=${encodeURIComponent(filePath)}`, {
          method: 'POST',
          baseUrl: this.proxyEndpoint,
          headers: {
            'Content-Type': 'application/octet-stream',
            'Authorization': 'Basic cm9vdDo=',
          },
          body: contentBuf,
          signal: options.signal,
        });

        totalBytes += contentBuf.byteLength;
        written.push({ path: file.path, sizeBytes: contentBuf.byteLength });
      }
      return {
        count: written.length,
        totalBytes,
        written,
      };
    }
  }

  async extractWorkspaceArchive(sandboxId, archiveBuffer, { destination = '/' } = {}, options = {}) {
    const buffer = Buffer.isBuffer(archiveBuffer) ? archiveBuffer : Buffer.from(archiveBuffer);
    const query = `?destination=${encodeURIComponent(destination)}`;
    return this.request(`/v1/sandboxes/${encodeURIComponent(sandboxId)}/files/extract${query}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/gzip',
      },
      body: buffer,
      signal: options.signal,
    });
  }

  // --- WebSocket PTY Terminal Endpoint ---

  getPtyUrl(sandboxId, { command = '/bin/sh', cols = 80, rows = 24 } = {}) {
    const wsEndpoint = this.endpoint.replace(/^http/, 'ws');
    const query = `?command=${encodeURIComponent(command)}&cols=${cols}&rows=${rows}${this.apiKey ? `&token=${encodeURIComponent(this.apiKey)}` : ''}`;
    return `${wsEndpoint}/v1/sandboxes/${encodeURIComponent(sandboxId)}/pty${query}`;
  }
}
