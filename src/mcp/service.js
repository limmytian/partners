import { McpOperations } from './operations.js';
import { MCP_LIMITS, parseMcpArguments } from './contract.js';
import { mcpError } from './coordination.js';
import { redactSensitiveContent } from '../security/workspace-security.js';

const errorCodes = new Set(['INVALID_ARGUMENT','UNAUTHENTICATED','FORBIDDEN','NOT_FOUND','UNSUPPORTED_CAPABILITY','SESSION_BUSY','SESSION_EXPIRED','QUOTA_EXCEEDED','IDEMPOTENCY_CONFLICT','IDEMPOTENCY_EXPIRED','WRITE_CONFLICT','PROVIDER_UNAVAILABLE','OPERATION_PENDING','RECOVERY_REQUIRED','BINARY_UNSUPPORTED','FILE_TOO_LARGE','DIRECTORY_TOO_LARGE']);
const terminal = new Set(['succeeded', 'failed', 'timed_out', 'cancelled']);
export class SandboxMcpService extends McpOperations {
  constructor(options) {
    super(options);
    this.running = new Map(); this.limits = { ...MCP_LIMITS, ...options.limits };
    this.allowedProfiles = options.allowedProfiles ?? [];
  }
  async initialize() { await this.coordinator.migrate(); }
  async call(name, input, headers, traceId = this.newId('trace')) {
    const started = this.clock(); let auth, resourceId;
    try {
      const args = parseMcpArguments(name, input);
      let value;
      if (name === 'session_create') auth = await this.authorize(headers, 'sessions:create', args);
      else {
        const job = name.startsWith('job_');
        const scope = ({ session_get: 'sessions:read', session_delete: 'sessions:delete', bash_exec: 'jobs:create', job_get: 'jobs:read', job_cancel: 'jobs:cancel' })[name]
          ?? (args.action === 'write' ? 'sessions:write' : 'sessions:read');
        resourceId = job ? args.jobId : args.sessionId;
        ({ value, auth } = await this.resource(job ? 'job' : 'session', resourceId, headers, scope));
        if (!job && !value.metadata?.mcp) throw mcpError('FORBIDDEN');
        if (!job && this.gateway.provider.restoreSession) this.gateway.provider.restoreSession(value);
        if (!job && !['session_delete', 'session_get'].includes(name)) await this.checkSession(value);
      }
      const response = await this.dispatch(name, args, value, auth, headers);
      resourceId ??= response.sessionId ?? response.jobId;
      await this.audit(auth, ['session_create','session_get','session_delete','bash_exec','job_get','job_cancel','file_ops'].includes(name) ? name : 'unknown', resourceId, 'accepted', null, this.clock() - started, traceId);
      return response;
    } catch (error) {
      const known = errorCodes.has(error.code);
      const safe = known ? error : mcpError('PROVIDER_UNAVAILABLE', false);
      await this.audit(auth, ['session_create','session_get','session_delete','bash_exec','job_get','job_cancel','file_ops'].includes(name) ? name : 'unknown', resourceId, 'denied', safe.code, this.clock() - started, traceId);
      throw safe;
    }
  }
  async dispatch(name, args, value, auth, headers) {
    if (name === 'session_create') {
      if (args.profile && !this.allowedProfiles.includes(args.profile)) throw mcpError('FORBIDDEN');
      return this.once(name, args, args, null, async (record, update) => this.lock('tenant:' + args.tenantId, async () => {
        const count = await this.gateway.store.countActiveSessions(args.tenantId);
        if (count >= this.limits.tenantSessions) throw mcpError('QUOTA_EXCEEDED');
        const sessionId = this.newId('ses'); await update({ resourceId: sessionId });
        const now = this.clock();
        const session = await this.gateway.createSession({ id: sessionId, tenantId: args.tenantId, projectId: args.projectId,
          actor: auth.actor, ...(args.profile ? { sandbox: { profile: args.profile } } : {}),
          metadata: { mcp: { idleSeconds: Math.min(args.ttlSeconds, this.limits.idleSeconds), lastUsedAt: now,
            expiresAt: now + this.limits.lifetimeSeconds * 1000 } } });
        await update({ resourceId: session.id });
        return this.publicSession(session);
      }));
    }
    if (name === 'session_get') return this.publicSession(value);
    if (name === 'session_delete') {
      if (value.metadata?.mcp?.quarantined) {
        const existing = await this.coordinator.get('lock:' + value.id);
        const deleted = await this.gateway.deleteSession(value.id);
        if (existing) await this.coordinator.release('lock:' + value.id, existing.owner);
        return this.publicSession(deleted);
      }
      if (value.state === 'deleted') return this.publicSession(value);
      return this.lock(value.id, async () => {
        if ((await this.gateway.store.listJobs({ sessionId: value.id })).some(j => !terminal.has(j.state))) throw mcpError('SESSION_BUSY', true);
        return this.publicSession(await this.gateway.deleteSession(value.id));
      });
    }
    if (name === 'bash_exec') {
      return this.once(name, args, value, value.id, async (record, update) => {
        const jobId = this.newId('job'); await update({ resourceId: jobId });
        return this.submit(value, auth, { jobId, argv: ['bash', '-lc', args.command], cwd: args.cwd,
          timeoutSeconds: Math.min(args.timeoutSeconds, this.limits.maxTimeoutSeconds) });
      });
    }
    if (name === 'job_cancel') {
      if (terminal.has(value.state)) return this.publicJob(value);
      await this.gateway.cancel(value.id, args.reason);
      return this.publicJob(await this.gateway.getJob(value.id));
    }
    if (name === 'job_get') {
      await this.diagnoseInterruptedJob(value);
      return this.readJob(await this.gateway.getJob(value.id), args, headers);
    }
    if (name === 'file_ops') {
      if (!this.gateway.provider.mcpFileOperation) throw mcpError('UNSUPPORTED_CAPABILITY');
      const work = () => this.lock(value.id, async () => {
        await this.checkSession(await this.gateway.store.getSession(value.id));
        if ((await this.gateway.store.listJobs({ sessionId: value.id })).some(j => !terminal.has(j.state))) throw mcpError('SESSION_BUSY', true);
        let result;
        try { result = await this.gateway.mcpFileOperation(value.id, args); }
        catch (error) {
          if (!errorCodes.has(error.code) || error.code === 'PROVIDER_UNAVAILABLE') await this.quarantine(value.id, null);
          throw error;
        }
        await this.touch(value.id);
        return { sessionId: value.id, ...result };
      });
      return args.action === 'write' ? this.once('file_write', args, value, value.id, work) : work();
    }
    throw mcpError('INVALID_ARGUMENT');
  }
  async submit(session, auth, { jobId, argv, cwd, timeoutSeconds }) {
    const key = 'lock:' + session.id;
    const { acquired, record } = await this.coordinator.claim(key, '', { state: 'job', jobId, createdAt: this.clock(), heartbeatAt: this.clock() });
    if (!acquired) throw mcpError('SESSION_BUSY', true);
    let started = false;
    try {
      await this.checkSession(await this.gateway.store.getSession(session.id));
      return await this.lock('tenant:' + session.tenantId, async () => {
        const jobs = await this.gateway.store.listJobs({ sessionId: session.id });
        if (await this.gateway.store.countActiveJobs(session.tenantId) >= this.limits.tenantJobs) throw mcpError('QUOTA_EXCEEDED');
        if (jobs.some(j => j.sessionId === session.id && !terminal.has(j.state))) throw mcpError('SESSION_BUSY', true);
        const now = new Date(this.clock()).toISOString();
        const request = { id: jobId, executionMode: 'workspace_session', sessionId: session.id,
          tenantId: session.tenantId, projectId: session.projectId, command: { argv, cwd: '/workspace/' + cwd }, timeoutSeconds,
          actor: auth.actor, artifactPolicy: { collect: ['stdout', 'stderr'] }, metadata: { mcp: true } };
        // Persist a recoverable resource before any provider execution starts.
        await this.gateway.store.saveJob({ id: jobId, state: 'queued', executionMode: request.executionMode,
          sessionId: session.id, tenantId: session.tenantId, projectId: session.projectId,
          provider: this.gateway.provider.name, timeoutSeconds, createdAt: now, updatedAt: now, metadata: { mcp: true } });
        await this.touch(session.id);
        started = true;
        let checking = false, cancellationSent = false;
        const heartbeat = setInterval(async () => {
          if (checking) return; checking = true;
          try {
            record.heartbeatAt = this.clock(); await this.coordinator.update(key, record.owner, record);
            const cancellation = await this.gateway.store.getCancellation(jobId);
            if (cancellation && !cancellationSent) { cancellationSent = true; await this.gateway.cancel(jobId, cancellation.reason); }
          } catch {} finally { checking = false; }
        }, 2000); heartbeat.unref();
        const completion = this.gateway.runJob(request).then(async result => {
          const providerSession = this.gateway.provider.sessions?.get(session.id);
          if (['cancelled','timed_out'].includes(result.state) && this.gateway.provider.name === 'cubesandbox' && this.gateway.provider.mode === 'remote' && !providerSession) {
            const stored = await this.gateway.store.getSession(session.id);
            if (stored) await this.gateway.store.saveSession({ ...stored, state: 'deleted' });
          }
          if (result.state === 'failed' && result.exitCode == null) await this.quarantine(session.id, jobId);
          return result;
        }).finally(async () => {
          clearInterval(heartbeat);
          await this.touch(session.id);
          const stored = await this.gateway.store.getSession(session.id);
          if (!stored?.metadata?.mcp?.quarantined) await this.coordinator.release(key, record.owner);
          this.running.delete(jobId);
        });
        this.running.set(jobId, completion);
        completion.catch(() => {});
        return { jobId, sessionId: session.id, state: 'accepted' };
      });
    } finally { if (!started) await this.coordinator.release(key, record.owner); }
  }
  async checkSession(session) {
    if (!session || session.state === 'deleted') throw mcpError('SESSION_EXPIRED');
    const mcp = session.metadata?.mcp;
    if (!mcp) throw mcpError('FORBIDDEN');
    if (mcp.quarantined) throw mcpError('RECOVERY_REQUIRED');
    const jobs = await this.gateway.store.listJobs({ sessionId: session.id });
    const active = jobs.some(j => !terminal.has(j.state));
    if (mcp.expiresAt <= this.clock() || (!active && mcp.lastUsedAt + mcp.idleSeconds * 1000 <= this.clock())) throw mcpError('SESSION_EXPIRED');
  }
  async touch(id) {
    const session = await this.gateway.store.getSession(id);
    if (session?.metadata?.mcp && session.state !== 'deleted') {
      session.metadata.mcp.lastUsedAt = this.clock();
      await this.gateway.store.saveSession(session);
    }
  }
  publicSession(session) {
    return { sessionId: session.id, state: session.state, expiresAt: session.metadata?.mcp?.expiresAt ?? null,
      quarantined: Boolean(session.metadata?.mcp?.quarantined),
      capabilities: { bash_exec: true, file_ops: Boolean(this.gateway.provider.mcpFileOperation) }, limits: this.limits };
  }
  publicJob(job) {
    return { jobId: job.id, sessionId: job.sessionId, state: job.state, exitCode: job.exitCode ?? null,
      terminalReason: job.metadata?.mcpRecovery ? 'EXECUTION_UNKNOWN' : job.terminalReason ?? null, outputTruncated: Boolean(job.metadata?.mcpOutputTruncated) };
  }
  async readJob(job, args, headers) {
    const [sequence, offset] = args.cursor.split(':').map(Number);
    if (!Number.isSafeInteger(sequence) || !Number.isSafeInteger(offset)) throw mcpError('INVALID_ARGUMENT');
    const events = await this.gateway.listJobEvents(job.id, { afterSequence: Math.max(0, sequence - 1), limit: 100 });
    const max = Math.min(args.maxOutputBytes, this.limits.maxOutputBytes);
    let stdout = '', stderr = '', used = 0, nextCursor = args.cursor, truncated = false;
    for (const event of events) {
      if (event.type !== 'log.stdout' && event.type !== 'log.stderr') { nextCursor = `${event.sequence + 1}:0`; continue; }
      const chunk = redactSensitiveContent(event.chunk ?? event.payload?.chunk ?? '');
      const buffer = Buffer.from(chunk), start = event.sequence === sequence ? offset : 0;
      if (start > buffer.length || (start < buffer.length && (buffer[start] & 0xc0) === 0x80)) throw mcpError('INVALID_ARGUMENT');
      const text = utf8Prefix(buffer.subarray(start), max - used);
      if (event.type === 'log.stdout') stdout += text; else stderr += text;
      const consumed = Buffer.byteLength(text); used += consumed;
      if (start + consumed < buffer.length) { nextCursor = `${event.sequence}:${start + consumed}`; truncated = true; break; }
      nextCursor = `${event.sequence + 1}:0`;
      if (used >= max) { truncated = true; break; }
    }
    if (events.length === 100) truncated = true;
    let artifactRefs = [];
    try {
      await this.authorize(headers, 'artifacts:read', job);
      artifactRefs = (await this.gateway.listJobArtifacts(job.id)).map(a => ({ artifactId: a.id, kind: a.kind, name: a.name,
        downloadPath: '/v1/artifacts/' + encodeURIComponent(a.id) + '/download' }));
    } catch (error) { if (error.code !== 'FORBIDDEN') throw error; }
    return { ...this.publicJob(job), stdout, stderr, nextCursor, truncated, artifactRefs };
  }
  async quarantine(sessionId, jobId) {
    const session = await this.gateway.store.getSession(sessionId);
    if (session?.metadata?.mcp && session.state !== 'deleted') {
      session.metadata.mcp.quarantined = true; session.state = 'failed';
      await this.gateway.store.saveSession(session);
    }
    const job = await this.gateway.store.getJob(jobId);
    if (job && (!terminal.has(job.state) || (job.state === 'failed' && job.exitCode == null))) {
      job.state = 'failed'; job.metadata = { ...job.metadata, mcpRecovery: true };
      job.exitCode = null; job.completedAt = new Date(this.clock()).toISOString();
      await this.gateway.store.saveJob(job);
    }
  }
  async diagnoseInterruptedJob(job) {
    if (terminal.has(job.state) || !job.metadata?.mcp) return;
    const lock = await this.coordinator.get('lock:' + job.sessionId);
    if (!lock || (lock.heartbeatAt ?? lock.createdAt) + 45000 < this.clock()) {
      await this.quarantine(job.sessionId, job.id);
    }
  }
  async sweep() {
    const sessions = [];
    for (let offset = 0; ; offset += 200) {
      const page = await this.gateway.store.listSessions({ limit: 200, offset });
      sessions.push(...page); if (page.length < 200) break;
    }
    for (let session of sessions.filter(s => s.metadata?.mcp && s.state !== 'deleted')) {
      let mcp = session.metadata.mcp, jobs = await this.gateway.store.listJobs({ sessionId: session.id });
      for (const job of jobs) await this.diagnoseInterruptedJob(job);
      session = await this.gateway.store.getSession(session.id);
      mcp = session.metadata.mcp;
      const active = (await this.gateway.store.listJobs({ sessionId: session.id })).filter(j => !terminal.has(j.state));
      if (mcp.expiresAt > this.clock() && (active.length || mcp.lastUsedAt + mcp.idleSeconds * 1000 > this.clock())) continue;
      for (const job of active) {
        await this.gateway.cancel(job.id, 'MCP workspace lifetime expired');
        if (mcp.expiresAt + this.limits.graceSeconds * 1000 <= this.clock()) {
          await this.quarantine(session.id, job.id);
          const quarantined = await this.gateway.store.getSession(session.id);
          await this.dispatch('session_delete', { sessionId: session.id }, quarantined);
        }
      }
      if (active.length) continue; // Provider must confirm termination before workspace/lock reclamation.
      try { await this.dispatch('session_delete', { sessionId: session.id }, session); }
      catch (error) { if (error.code !== 'SESSION_BUSY') throw error; }
    }
  }
  async close() {
    for (const jobId of this.running.keys()) await this.gateway.cancel(jobId, 'gateway shutting down');
    await Promise.race([Promise.allSettled(this.running.values()), new Promise(resolve => { const timer = setTimeout(resolve, 10000); timer.unref(); })]);
  }
}
export function utf8Prefix(buffer, maxBytes) {
  let end = Math.min(buffer.length, maxBytes);
  if (end < buffer.length) while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString('utf8');
}
