import { randomUUID } from 'node:crypto';
import { gatewayCoordinator, hash, mcpError } from './coordination.js';

// The same coordinator belongs to the GatewayStore, not a connection or transport.
export class McpOperations {
  constructor({ gateway, authorizer, clock = () => Date.now() }) {
    if (!authorizer?.enabled) throw new Error('MCP requires service-token authentication');
    this.gateway = gateway; this.authorizer = authorizer; this.clock = clock;
    this.coordinator = gatewayCoordinator(gateway.store);
  }
  async authorize(headers, scope, resource) {
    if (!resource?.tenantId || !resource?.projectId) throw mcpError('FORBIDDEN');
    try {
      return await this.authorizer.authorize({ headers, scope, tenantId: resource.tenantId, projectId: resource.projectId });
    } catch (error) { throw mcpError(error.statusCode === 401 ? 'UNAUTHENTICATED' : error.statusCode === 403 ? 'FORBIDDEN' : 'PROVIDER_UNAVAILABLE'); }
  }
  async resource(kind, id, headers, scope) {
    const value = await (kind === 'session' ? this.gateway.store.getSession(id) : this.gateway.store.getJob(id));
    if (!value) throw mcpError('NOT_FOUND');
    const auth = await this.authorize(headers, scope, value);
    return { value, auth };
  }
  async once(tool, args, scope, resourceId, work) {
    const key = 'request:' + hash({ tenantId: scope.tenantId, projectId: scope.projectId, tool, resourceId, requestId: args.requestId });
    const requestHash = hash(args);
    const initial = { state: 'pending', tool, resourceId, createdAt: this.clock(), expiresAt: this.clock() + 86400000 };
    const { acquired, record } = await this.coordinator.claim(key, requestHash, initial);
    if (!record) throw mcpError('OPERATION_PENDING', true);
    if (!acquired) {
      if (record.requestHash !== requestHash) throw mcpError('IDEMPOTENCY_CONFLICT');
      if (record.expiresAt <= this.clock()) throw mcpError('IDEMPOTENCY_EXPIRED', false, { resourceId: record.resourceId });
      if (record.state === 'done') return record.response;
      if (record.state === 'rejected') throw mcpError(record.errorCode);
      if (tool === 'bash_exec') {
        const job = await this.gateway.store.getJob(record.resourceId);
        if (job) return { jobId: job.id, sessionId: job.sessionId, state: 'accepted' };
      }
      if (tool === 'session_create') {
        const session = await this.gateway.store.getSession(record.resourceId);
        if (session && this.publicSession) return this.publicSession(session);
      }
      throw mcpError('OPERATION_PENDING', true, { resourceId: record.resourceId });
    }
    try {
      const response = await work(record, async patch => {
        Object.assign(record, patch); await this.coordinator.update(key, record.owner, record);
      });
      await this.coordinator.update(key, record.owner, { ...record, state: 'done', response });
      return response;
    } catch (error) {
      if (['SESSION_BUSY', 'QUOTA_EXCEEDED'].includes(error.code)) {
        // Admission failed before provider execution, so a later identical retry is safe.
        await this.coordinator.release(key, record.owner);
        throw error;
      }
      // Never rerun an uncertain side effect after a failure or process restart.
      if (['SESSION_BUSY', 'QUOTA_EXCEEDED', 'SESSION_EXPIRED', 'WRITE_CONFLICT', 'FORBIDDEN', 'NOT_FOUND', 'UNSUPPORTED_CAPABILITY'].includes(error.code)) {
        await this.coordinator.update(key, record.owner, { ...record, state: 'rejected', errorCode: error.code });
      }
      throw error;
    }
  }
  async lock(resourceId, work) {
    const key = 'lock:' + resourceId;
    const { acquired, record } = await this.coordinator.claim(key, '', { state: 'locked', createdAt: this.clock(), heartbeatAt: this.clock() });
    if (!acquired) throw mcpError('SESSION_BUSY', true);
    const heartbeat = setInterval(() => { record.heartbeatAt = this.clock(); void this.coordinator.update(key, record.owner, record).catch(() => {}); }, 5000); heartbeat.unref();
    try { return await work(); } finally { clearInterval(heartbeat); await this.coordinator.release(key, record.owner); }
  }
  async audit(auth, tool, resourceId, outcome, code, durationMs, traceId) {
    this.gateway.metrics?.recordMcpCall?.({ tool, code, durationMs });
    await this.gateway.store.recordAudit?.({ action: 'mcp.tool', actor: auth?.actor,
      tokenRef: auth?.tokenRef, tenantId: auth?.tenantId, projectId: auth?.projectId,
      resourceId, outcome, metadata: { tool, code, durationMs, traceId } });
  }
  newId(kind) { return `${kind}_${randomUUID()}`; }
}
