/**
 * CubeSandboxClient: Lightweight HTTP REST client for communicating with the
 * CubeSandbox MicroVM daemon service.
 */
export class CubeSandboxClient {
  constructor(options = {}) {
    this.endpoint = (options.endpoint ?? process.env.CUBESANDBOX_ENDPOINT ?? 'http://127.0.0.1:9090').replace(/\/+$/, '');
    this.apiKey = options.apiKey ?? process.env.CUBESANDBOX_API_KEY ?? null;
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
  } = {}) {
    const url = `${this.endpoint}${path.startsWith('/') ? path : `/${path}`}`;
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
    return this.request('/v1/info', {
      method: 'GET',
      signal: options.signal,
    });
  }

  // --- Sandbox Lifecycle ---

  async createSandbox(request = {}, options = {}) {
    return this.request('/v1/sandboxes', {
      method: 'POST',
      body: request,
      signal: options.signal,
    });
  }

  async getSandbox(sandboxId, options = {}) {
    return this.request(`/v1/sandboxes/${encodeURIComponent(sandboxId)}`, {
      method: 'GET',
      signal: options.signal,
    });
  }

  async deleteSandbox(sandboxId, options = {}) {
    return this.request(`/v1/sandboxes/${encodeURIComponent(sandboxId)}`, {
      method: 'DELETE',
      signal: options.signal,
    });
  }

  async listSandboxes(options = {}) {
    return this.request('/v1/sandboxes', {
      method: 'GET',
      signal: options.signal,
    });
  }

  // --- Command & Job Execution ---

  async exec(sandboxId, request = {}, options = {}) {
    const rawRes = await this.request(`/v1/sandboxes/${encodeURIComponent(sandboxId)}/exec`, {
      method: 'POST',
      body: request,
      signal: options.signal,
      rawResponse: true,
    });

    if (!rawRes.ok) {
      let errMessage = `CubeSandbox exec failed: HTTP ${rawRes.status}`;
      try {
        const body = await rawRes.json();
        if (body.error) errMessage = body.error;
      } catch {}
      const error = new Error(errMessage);
      error.status = rawRes.status;
      throw error;
    }

    const contentType = rawRes.headers.get('content-type') ?? '';

    // Handle streaming response (SSE or chunked ndjson)
    if (contentType.includes('text/event-stream') || contentType.includes('application/x-ndjson')) {
      return this._consumeStream(rawRes, options.onChunk);
    }

    return await rawRes.json();
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
    });
  }

  // --- Snapshot & Instant Fork (CubeCoW) ---

  async createSnapshot(sandboxId, { label = 'default' } = {}, options = {}) {
    return this.request(`/v1/sandboxes/${encodeURIComponent(sandboxId)}/snapshots`, {
      method: 'POST',
      body: { label },
      signal: options.signal,
    });
  }

  async getSnapshot(snapshotId, options = {}) {
    return this.request(`/v1/snapshots/${encodeURIComponent(snapshotId)}`, {
      method: 'GET',
      signal: options.signal,
    });
  }

  async listSnapshots({ sandboxId = null } = {}, options = {}) {
    const query = sandboxId ? `?sandboxId=${encodeURIComponent(sandboxId)}` : '';
    return this.request(`/v1/snapshots${query}`, {
      method: 'GET',
      signal: options.signal,
    });
  }

  async forkFromSnapshot(snapshotId, request = {}, options = {}) {
    return this.request(`/v1/snapshots/${encodeURIComponent(snapshotId)}/fork`, {
      method: 'POST',
      body: request,
      signal: options.signal,
    });
  }

  // --- Workspace File Operations ---

  async listWorkspaceTree(sandboxId, { path: dirPath = '/', maxDepth = 4 } = {}, options = {}) {
    const query = `?path=${encodeURIComponent(dirPath)}&maxDepth=${maxDepth}`;
    return this.request(`/v1/sandboxes/${encodeURIComponent(sandboxId)}/files/tree${query}`, {
      method: 'GET',
      signal: options.signal,
    });
  }

  async readWorkspaceFile(sandboxId, filePath, { maxBytes = 65536 } = {}, options = {}) {
    const query = `?path=${encodeURIComponent(filePath)}&maxBytes=${maxBytes}`;
    return this.request(`/v1/sandboxes/${encodeURIComponent(sandboxId)}/files/read${query}`, {
      method: 'GET',
      signal: options.signal,
    });
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
    return this.request(`/v1/sandboxes/${encodeURIComponent(sandboxId)}/files/sync`, {
      method: 'POST',
      body: { files, overwrite },
      signal: options.signal,
    });
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
