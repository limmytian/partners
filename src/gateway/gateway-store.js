import { randomUUID } from 'node:crypto';

export class InMemoryGatewayStore {
  constructor() {
    this.sessions = new Map();
    this.jobs = new Map();
    this.events = new Map();
    this.artifacts = new Map();
    this.cancellations = new Map();
    this.idempotencyKeys = new Map();
    this.snapshots = new Map();
    this.templates = new Map();
    this.auditRecords = [];
    this.sequence = 0;
  }

  nextEventSequence() {
    this.sequence += 1;
    return this.sequence;
  }

  saveSession(session) {
    this.sessions.set(session.id, clone(session));
    return clone(session);
  }

  getSession(sessionId) {
    return clone(this.sessions.get(sessionId));
  }

  listSessions(options = {}) {
    let list = [...this.sessions.values()].sort((a, b) => new Date(b.createdAt ?? 0) - new Date(a.createdAt ?? 0));
    if (options.tenantId) list = list.filter((s) => s.tenantId === options.tenantId);
    if (options.projectId) list = list.filter((s) => s.projectId === options.projectId);
    if (options.state) list = list.filter((s) => s.state === options.state);
    const offset = options.offset ?? 0;
    const limit = options.limit ?? list.length;
    return list.slice(offset, offset + limit).map(clone);
  }

  saveJob(job) {
    this.jobs.set(job.id, clone(job));
    return clone(job);
  }

  getJob(jobId) {
    return clone(this.jobs.get(jobId));
  }

  listJobs(options = {}) {
    let list = [...this.jobs.values()].sort((a, b) => new Date(b.createdAt ?? 0) - new Date(a.createdAt ?? 0));
    if (options.tenantId) list = list.filter((j) => j.tenantId === options.tenantId);
    if (options.projectId) list = list.filter((j) => j.projectId === options.projectId);
    if (options.sessionId) list = list.filter((j) => j.sessionId === options.sessionId);
    if (options.state) list = list.filter((j) => j.state === options.state);
    const offset = options.offset ?? 0;
    const limit = options.limit ?? list.length;
    return list.slice(offset, offset + limit).map(clone);
  }

  initializeJobBuckets(jobId) {
    if (!this.events.has(jobId)) {
      this.events.set(jobId, []);
    }
    if (!this.artifacts.has(jobId)) {
      this.artifacts.set(jobId, []);
    }
  }

  appendEvent(jobId, event) {
    const stored = clone(event);
    const bucket = this.events.get(jobId) ?? [];
    bucket.push(stored);
    this.events.set(jobId, bucket);
    return clone(stored);
  }

  listJobEvents(jobId, { afterSequence = 0 } = {}) {
    return (this.events.get(jobId) ?? [])
      .filter((event) => event.sequence > afterSequence)
      .map(clone);
  }

  saveArtifact(jobId, artifact) {
    const bucket = this.artifacts.get(jobId) ?? [];
    const record = { ...artifact, jobId: artifact.jobId ?? jobId };
    if (!bucket.some((item) => item.id === record.id)) {
      bucket.push(clone(record));
      this.artifacts.set(jobId, bucket);
    }
    return clone(record);
  }

  listJobArtifacts(jobId) {
    return (this.artifacts.get(jobId) ?? []).map(clone);
  }

  getArtifact(artifactId) {
    for (const artifacts of this.artifacts.values()) {
      const artifact = artifacts.find((item) => item.id === artifactId);
      if (artifact) {
        return clone(artifact);
      }
    }
    return null;
  }

  recordCancellation(jobId, cancellation) {
    const record = {
      jobId,
      reason: cancellation.reason ?? 'cancelled',
      requestedAt: cancellation.requestedAt,
    };
    this.cancellations.set(jobId, clone(record));
    return clone(record);
  }

  getCancellation(jobId) {
    return clone(this.cancellations.get(jobId));
  }

  saveIdempotencyKey(key, value) {
    const record = {
      key,
      ...value,
    };
    this.idempotencyKeys.set(key, clone(record));
    return clone(record);
  }

  getIdempotencyKey(key) {
    return clone(this.idempotencyKeys.get(key));
  }

  listIdempotencyKeys(options = {}) {
    let list = [...this.idempotencyKeys.values()].sort((a, b) => new Date(b.createdAt ?? 0) - new Date(a.createdAt ?? 0));
    if (options.tenantId) list = list.filter((k) => k.tenantId === options.tenantId);
    if (options.scope) list = list.filter((k) => k.scope === options.scope);
    const offset = options.offset ?? 0;
    const limit = options.limit ?? list.length;
    return list.slice(offset, offset + limit).map(clone);
  }

  saveSnapshot(snapshot) {
    this.snapshots.set(snapshot.id, clone(snapshot));
    return clone(snapshot);
  }

  getSnapshot(snapshotId) {
    return clone(this.snapshots.get(snapshotId));
  }

  listSnapshots(options = {}) {
    let list = [...this.snapshots.values()].sort((a, b) => new Date(b.createdAt ?? 0) - new Date(a.createdAt ?? 0));
    if (options.tenantId) list = list.filter((s) => s.tenantId === options.tenantId);
    if (options.projectId) list = list.filter((s) => s.projectId === options.projectId);
    if (options.sessionId) list = list.filter((s) => s.sessionId === options.sessionId);
    const offset = options.offset ?? 0;
    const limit = options.limit ?? list.length;
    return list.slice(offset, offset + limit).map(clone);
  }

  saveTemplate(template) {
    this.templates.set(template.id, clone(template));
    return clone(template);
  }

  getTemplate(templateId) {
    return clone(this.templates.get(templateId));
  }

  listTemplates(options = {}) {
    let list = [...this.templates.values()].sort((a, b) => new Date(b.createdAt ?? 0) - new Date(a.createdAt ?? 0));
    if (options.tenantId) list = list.filter((t) => t.tenantId === options.tenantId);
    if (options.projectId) list = list.filter((t) => t.projectId === options.projectId);
    const offset = options.offset ?? 0;
    const limit = options.limit ?? list.length;
    return list.slice(offset, offset + limit).map(clone);
  }

  recordAudit(record = {}) {
    const audit = {
      id: record.id ?? `aud_${randomUUID()}`,
      action: record.action ?? 'unknown',
      scope: record.scope ?? null,
      tokenRef: record.tokenRef ?? null,
      actor: record.actor ?? null,
      tenantId: record.tenantId ?? null,
      projectId: record.projectId ?? null,
      resourceType: record.resourceType ?? null,
      resourceId: record.resourceId ?? null,
      outcome: record.outcome ?? 'accepted',
      reason: record.reason ?? null,
      metadata: record.metadata ?? {},
      at: record.at ?? new Date().toISOString(),
    };
    this.auditRecords.unshift(clone(audit));
    return clone(audit);
  }

  listAuditRecords(options = {}) {
    let list = this.auditRecords;
    if (options.tokenRef) list = list.filter((r) => r.tokenRef === options.tokenRef);
    if (options.actor) list = list.filter((r) => r.actor === options.actor);
    if (options.action) list = list.filter((r) => r.action === options.action);
    if (options.outcome) list = list.filter((r) => r.outcome === options.outcome);
    if (options.tenantId) list = list.filter((r) => r.tenantId === options.tenantId);
    if (options.projectId) list = list.filter((r) => r.projectId === options.projectId);
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 50;
    return list.slice(offset, offset + limit).map(clone);
  }

  getOverview() {
    const jobs = [...this.jobs.values()];
    const sessions = [...this.sessions.values()];
    const jobsByState = {};
    for (const job of jobs) {
      jobsByState[job.state] = (jobsByState[job.state] ?? 0) + 1;
    }
    const sessionsByState = {};
    for (const session of sessions) {
      sessionsByState[session.state] = (sessionsByState[session.state] ?? 0) + 1;
    }
    return {
      jobs: {
        total: jobs.length,
        running: (jobsByState.running ?? 0) + (jobsByState.preparing ?? 0),
        byState: jobsByState,
      },
      sessions: {
        total: sessions.length,
        active: (sessionsByState.ready ?? 0) + (sessionsByState.busy ?? 0) + (sessionsByState.provisioning ?? 0),
        byState: sessionsByState,
      },
      auditRecordsCount: this.auditRecords.length,
      idempotencyKeysCount: this.idempotencyKeys.size,
    };
  }
}

function clone(value) {
  if (value === undefined || value === null) {
    return value ?? null;
  }
  return structuredClone(value);
}
