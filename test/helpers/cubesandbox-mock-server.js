import http from 'node:http';

/**
 * Creates an in-memory HTTP server implementing the CubeSandbox REST API for testing.
 */
export async function createCubeSandboxMockServer(options = {}) {
  const { apiKey = null } = options;

  const sandboxes = new Map();
  const snapshots = new Map();
  let executedJobs = [];

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');

      if (apiKey) {
        const auth = req.headers.authorization;
        if (auth !== `Bearer ${apiKey}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized: invalid or missing API key' }));
          return;
        }
      }

      // Read JSON body if present
      let body = null;
      if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
        const chunks = [];
        for await (const chunk of req) {
          chunks.push(chunk);
        }
        const rawBody = Buffer.concat(chunks);
        const contentType = req.headers['content-type'] ?? '';
        if (contentType.includes('application/json') && rawBody.length > 0) {
          body = JSON.parse(rawBody.toString('utf8'));
        } else {
          body = rawBody;
        }
      }

      // Routes
      if (req.method === 'GET' && url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', version: '0.1.0-cube', kernel: '6.6.30-cube-microvm', kvm: true }));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/v1/info') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          version: '0.1.0-cube',
          kernelVersion: '6.6.30-cube-microvm',
          kvm: true,
          capabilities: ['MicroVMIsolation', 'Sub60msColdStart', 'MemorySnapshot', 'InstantFork'],
        }));
        return;
      }

      // Sandboxes
      if (req.method === 'POST' && url.pathname === '/v1/sandboxes') {
        const id = body?.id ?? `cube_ses_${Date.now()}`;
        const sandbox = {
          id,
          status: 'ready',
          resources: body?.resources ?? { vCpu: 1, memoryMib: 512 },
          microVm: {
            vmId: `vm_${id.slice(-6)}`,
            kernelVersion: '6.6.30-cube-microvm',
            isolation: 'hardware_virtualization_kvm',
            coldStartMs: 38,
            ...(body?.snapshotId ? { restoredFromSnapshot: body.snapshotId } : {}),
          },
          createdAt: new Date().toISOString(),
        };
        sandboxes.set(id, sandbox);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(sandbox));
        return;
      }

      const sandboxMatch = url.pathname.match(/^\/v1\/sandboxes\/([^/]+)$/);
      if (sandboxMatch) {
        const id = decodeURIComponent(sandboxMatch[1]);
        if (req.method === 'GET') {
          const sb = sandboxes.get(id);
          if (!sb) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Sandbox not found: ${id}` }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(sb));
          return;
        }
        if (req.method === 'DELETE') {
          const sb = sandboxes.get(id);
          if (!sb) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Sandbox not found: ${id}` }));
            return;
          }
          sandboxes.delete(id);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id, deleted: true }));
          return;
        }
      }

      // Exec
      const execMatch = url.pathname.match(/^\/v1\/sandboxes\/([^/]+)\/exec$/);
      if (req.method === 'POST' && execMatch) {
        const id = decodeURIComponent(execMatch[1]);
        executedJobs.push({ sandboxId: id, body });

        // Check if stream requested via query or header
        if (req.headers.accept?.includes('text/event-stream')) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          res.write(`data: ${JSON.stringify({ stdout: 'executing in microvm...\n' })}\n\n`);
          res.write(`data: ${JSON.stringify({ stdout: 'done!\n', exitCode: 0 })}\n\n`);
          res.end();
          return;
        }

        let stdout = 'exec output';
        if (body?.code) {
          stdout = `result of ${body.code}`;
        } else if (body?.argv) {
          stdout = `executed ${body.argv.join(' ')}`;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          exitCode: 0,
          stdout,
          stderr: '',
          durationMs: 42,
        }));
        return;
      }

      // Cancel
      const cancelMatch = url.pathname.match(/^\/v1\/sandboxes\/([^/]+)\/cancel$/);
      if (req.method === 'POST' && cancelMatch) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ cancelled: true }));
        return;
      }

      // Snapshot
      const snapMatch = url.pathname.match(/^\/v1\/sandboxes\/([^/]+)\/snapshots$/);
      if (req.method === 'POST' && snapMatch) {
        const sandboxId = decodeURIComponent(snapMatch[1]);
        const snapId = `cube_snap_${Date.now()}`;
        const record = {
          id: snapId,
          sandboxId,
          label: body?.label ?? 'default',
          vmId: `vm_${sandboxId.slice(-6)}`,
          createdAt: new Date().toISOString(),
        };
        snapshots.set(snapId, record);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(record));
        return;
      }

      const getSnapMatch = url.pathname.match(/^\/v1\/snapshots\/([^/]+)$/);
      if (req.method === 'GET' && getSnapMatch) {
        const snapId = decodeURIComponent(getSnapMatch[1]);
        const record = snapshots.get(snapId);
        if (!record) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Snapshot not found: ${snapId}` }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(record));
        return;
      }

      // Fork
      const forkMatch = url.pathname.match(/^\/v1\/snapshots\/([^/]+)\/fork$/);
      if (req.method === 'POST' && forkMatch) {
        const snapId = decodeURIComponent(forkMatch[1]);
        const snapshot = snapshots.get(snapId);
        if (!snapshot) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Snapshot not found: ${snapId}` }));
          return;
        }
        const forkedId = body?.id ?? `cube_fork_${Date.now()}`;
        const forked = {
          id: forkedId,
          status: 'ready',
          resources: body?.resources ?? { vCpu: 1, memoryMib: 512 },
          microVm: {
            vmId: `vm_fork_${forkedId.slice(-6)}`,
            forkedFrom: snapId,
            parentSessionId: snapshot.sandboxId,
            isolation: 'hardware_virtualization_kvm',
          },
          createdAt: new Date().toISOString(),
        };
        sandboxes.set(forkedId, forked);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(forked));
        return;
      }

      // Files: Tree
      const treeMatch = url.pathname.match(/^\/v1\/sandboxes\/([^/]+)\/files\/tree$/);
      if (req.method === 'GET' && treeMatch) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          files: [
            { path: 'index.js', type: 'file', size: 120 },
            { path: 'package.json', type: 'file', size: 240 },
          ],
        }));
        return;
      }

      // Files: Read
      const readMatch = url.pathname.match(/^\/v1\/sandboxes\/([^/]+)\/files\/read$/);
      if (req.method === 'GET' && readMatch) {
        const filePath = url.searchParams.get('path') ?? 'file.txt';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          path: filePath,
          content: 'hello from microvm',
          sizeBytes: 18,
        }));
        return;
      }

      // Files: Sync
      const syncMatch = url.pathname.match(/^\/v1\/sandboxes\/([^/]+)\/files\/sync$/);
      if (req.method === 'POST' && syncMatch) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          synced: true,
          count: body?.files?.length ?? 0,
        }));
        return;
      }

      // Files: Archive download
      const archiveMatch = url.pathname.match(/^\/v1\/sandboxes\/([^/]+)\/files\/archive$/);
      if (req.method === 'GET' && archiveMatch) {
        const dummyArchive = Buffer.from('FAKE_TAR_GZ_BYTES');
        res.writeHead(200, {
          'Content-Type': 'application/gzip',
          'Content-Disposition': 'attachment; filename="workspace.tar.gz"',
        });
        res.end(dummyArchive);
        return;
      }

      // Files: Extract
      const extractMatch = url.pathname.match(/^\/v1\/sandboxes\/([^/]+)\/files\/extract$/);
      if (req.method === 'POST' && extractMatch) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ extracted: true }));
        return;
      }

      // 404
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Not found: ${url.pathname}` }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    port,
    sandboxes,
    snapshots,
    executedJobs,
    close: async () => new Promise((resolve) => server.close(resolve)),
  };
}
