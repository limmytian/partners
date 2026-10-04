import { randomUUID } from 'node:crypto';

import {
  JobState,
  SessionState,
  assertSandboxConfiguration,
  assertExecutionJobRequest,
  createEvent,
} from '../core/provider-contract.js';
import { InMemoryGatewayStore } from './gateway-store.js';
import {
  IdempotencyScope,
  createIdempotencyContext,
  createJobIdempotencyRecord,
  isIdempotencyRecordExpired,
} from './idempotency.js';

export class InMemoryAgentExecutionGateway {
  constructor({
    provider,
    store = new InMemoryGatewayStore(),
    artifactStore = null,
    clock = () => new Date(),
    metrics = null,
  } = {}) {
    if (!provider?.runJob) {
      throw new TypeError('InMemoryAgentExecutionGateway requires a provider with runJob');
    }

    this.provider = provider;
    this.store = store;
    this.artifactStore = artifactStore;
    this.clock = clock;
    this.metrics = metrics;
  }

  async createSession(request = {}) {
    if (!this.provider.createSession) {
      throw new Error('Configured provider does not support sessions');
    }

    assertSandboxConfiguration(request.sandbox);

    const session = await this.provider.createSession(request);
    const now = this.#now();
    const record = {
      ...session,
      state: session.state ?? SessionState.Ready,
      provider: session.provider ?? this.provider.name,
      tenantId: request.tenantId ?? session.tenantId ?? null,
      projectId: request.projectId ?? session.projectId ?? null,
      createdAt: session.createdAt ?? now,
      updatedAt: session.updatedAt ?? now,
      metadata: request.metadata ?? {},
      actor: request.actor ?? null,
    };
    return this.store.saveSession(record);
  }

  async getSession(sessionId) {
    const local = await this.store.getSession(sessionId);
    if (local) {
      return local;
    }
    if (!this.provider.getSession) {
      return null;
    }
    const providerSession = await this.provider.getSession(sessionId);
    return providerSession ? { ...providerSession } : null;
  }

  async deleteSession(sessionId) {
    if (!this.provider.deleteSession) {
      throw new Error('Configured provider does not support session deletion');
    }

    const session = await this.provider.deleteSession(sessionId);
    const record = {
      ...((await this.store.getSession(sessionId)) ?? {}),
      ...session,
      state: session.state ?? SessionState.Deleted,
      updatedAt: session.updatedAt ?? this.#now(),
    };
    return this.store.saveSession(record);
  }

  async stopSession(sessionId) {
    if (this.provider.stopSession) {
      await this.provider.stopSession(sessionId);
    }
    const session = await this.store.getSession(sessionId);
    if (!session) {
      return null;
    }
    const record = {
      ...session,
      state: SessionState.Stopped,
      updatedAt: this.#now(),
    };
    return this.store.saveSession(record);
  }

  async listSessions(options = {}) {
    return this.store.listSessions?.(options) ?? [];
  }

  async listSessionWorkspaceTree(sessionId, options = {}) {
    if (!this.provider.listWorkspaceTree) {
      throw Object.assign(new Error('Provider does not support workspace tree browsing'), { statusCode: 501 });
    }
    return this.provider.listWorkspaceTree(sessionId, options);
  }

  async readSessionWorkspaceFile(sessionId, filePath, options = {}) {
    if (!this.provider.readWorkspaceFile) {
      throw Object.assign(new Error('Provider does not support reading workspace files'), { statusCode: 501 });
    }
    return this.provider.readWorkspaceFile(sessionId, filePath, options);
  }

  async downloadSessionWorkspaceFile(sessionId, filePath) {
    if (!this.provider.downloadWorkspaceFile) {
      throw Object.assign(new Error('Provider does not support downloading workspace files'), { statusCode: 501 });
    }
    return this.provider.downloadWorkspaceFile(sessionId, filePath);
  }

  async downloadSessionWorkspaceArchive(sessionId, options = {}) {
    if (!this.provider.downloadWorkspaceArchive) {
      throw Object.assign(new Error('Provider does not support workspace archive downloads'), { statusCode: 501 });
    }
    return this.provider.downloadWorkspaceArchive(sessionId, options);
  }

  async createSessionPty(sessionId, options = {}) {
    if (!this.provider.createPtySession) {
      throw Object.assign(new Error('Provider does not support interactive PTY sessions'), { statusCode: 501 });
    }
    return this.provider.createPtySession(sessionId, options);
  }

  async runJob(request, onEvent = () => {}) {
    assertExecutionJobRequest(request);

    const jobId = request.id ?? `job_${randomUUID()}`;
    const providerRequest = { ...request, id: jobId };
    const now = this.#now();
    const job = {
      id: jobId,
      state: JobState.Queued,
      executionMode: providerRequest.executionMode,
      tenantId: providerRequest.tenantId ?? null,
      projectId: providerRequest.projectId ?? null,
      sessionId: providerRequest.sessionId ?? null,
      sandbox: providerRequest.sandbox ?? null,
      provider: this.provider.name,
      providerJobId: null,
      timeoutSeconds: providerRequest.timeoutSeconds,
      exitCode: null,
      terminalReason: null,
      artifactCount: 0,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      metadata: providerRequest.metadata ?? {},
      actor: providerRequest.actor ?? null,
    };

    await this.store.saveJob(job);
    await this.store.initializeJobBuckets(jobId);
    this.metrics?.recordJobStarted?.({
      executionMode: job.executionMode,
      provider: job.provider,
    });

    let eventQueue = Promise.resolve();
    const emit = (event) => {
      eventQueue = eventQueue.then(async () => {
        const stored = await this.#storeEvent(jobId, event);
        await this.#applyEventToJob(job, stored);
        onEvent(stored);
        return stored;
      });
      return eventQueue;
    };

    await emit({ type: 'job.state', state: JobState.Queued, jobId });

    try {
      const result = await this.provider.runJob(providerRequest, emit);
      await eventQueue;
      await this.#storeResult(job, result);
      return {
        ...result,
        id: jobId,
        events: await this.listJobEvents(jobId),
        artifacts: await this.listJobArtifacts(jobId),
      };
    } catch (error) {
      let failure = error;
      try {
        await eventQueue;
      } catch (queueError) {
        failure = queueError;
      }
      const failed = await this.#failJob(job, failure);
      const events = await this.listJobEvents(jobId);
      onEvent(events.at(-1));
      return failed;
    }
  }

  async createJob(request, onEvent = () => {}) {
    return this.runJob(request, onEvent);
  }

  async saveJobIdempotencyRecord({
    idempotencyKey,
    request,
    responseBody,
    statusCode = 202,
    ttlSeconds,
  }) {
    const { storeKey, record } = createJobIdempotencyRecord({
      idempotencyKey,
      request,
      responseBody,
      statusCode,
      ttlSeconds,
      now: this.#now(),
    });
    return this.store.saveIdempotencyKey(storeKey, record);
  }

  async getJobIdempotencyRecord({ idempotencyKey, request, now = this.#now() }) {
    const context = createIdempotencyContext({
      idempotencyKey,
      scope: IdempotencyScope.JobsCreate,
      request,
      now,
    });
    const record = await this.store.getIdempotencyKey(context.storeKey);
    if (!record || isIdempotencyRecordExpired(record, now)) {
      return null;
    }
    return {
      ...record,
      matchesRequest: record.requestHash === context.requestHash,
    };
  }

  async getJob(jobId) {
    return this.store.getJob(jobId);
  }

  async listJobs(options = {}) {
    return this.store.listJobs?.(options) ?? [];
  }

  async listAuditRecords(options = {}) {
    return this.store.listAuditRecords?.(options) ?? [];
  }

  async listIdempotencyKeys(options = {}) {
    return this.store.listIdempotencyKeys?.(options) ?? [];
  }

  async getOverview() {
    const overview = (await this.store.getOverview?.()) ?? {};
    return {
      ...overview,
      uptimeSeconds: Math.floor(process.uptime()),
    };
  }

  async listJobEvents(jobId, { afterSequence = 0 } = {}) {
    return this.store.listJobEvents(jobId, { afterSequence });
  }

  async listJobArtifacts(jobId) {
    return this.store.listJobArtifacts(jobId);
  }

  async getArtifact(artifactId) {
    return this.store.getArtifact(artifactId);
  }

  async readArtifact(artifactId) {
    return this.artifactStore?.readArtifact(artifactId, await this.getArtifact(artifactId)) ?? null;
  }

  async cancel(jobId, reason = 'cancelled') {
    const job = await this.store.getJob(jobId);
    if (!job) {
      return null;
    }

    await this.store.recordCancellation(jobId, {
      reason,
      requestedAt: this.#now(),
    });

    const event = await this.#storeEvent(jobId, {
      type: 'job.state',
      state: JobState.CancelRequested,
      jobId,
      reason,
    });
    await this.#applyEventToJob(job, event);

    if (this.provider.cancel) {
      await this.provider.cancel(jobId, reason);
    }

    return this.store.getJob(jobId);
  }

  async #storeEvent(jobId, event) {
    const sequence = await this.store.nextEventSequence();
    const {
      id: _providerEventId,
      sequence: _providerSequence,
      at,
      type,
      ...payload
    } = event;
    const stored = createEvent(type ?? 'execution_event', {
      ...payload,
      jobId,
      provider: event.provider ?? this.provider.name,
      at: at ?? this.#now(),
    }, sequence);

    await this.store.appendEvent(jobId, stored);

    if (stored.type === 'artifact.created' && stored.artifact) {
      await this.#storeArtifact(jobId, stored.artifact);
    }

    return stored;
  }

  async #storeArtifact(jobId, artifact) {
    const record = this.artifactStore
      ? await this.artifactStore.writeArtifact({ ...artifact, jobId: artifact.jobId ?? jobId })
      : artifact;
    await this.store.saveArtifact(jobId, record);
  }

  async #applyEventToJob(job, event) {
    if (event.type === 'job.state' && event.state) {
      job.state = event.state;
      job.updatedAt = event.at;
    }
    if (event.type === 'job.final') {
      job.state = event.state ?? job.state;
      job.exitCode = event.exitCode ?? job.exitCode;
      job.artifactCount = event.artifactCount ?? job.artifactCount;
      job.completedAt = event.at;
      job.updatedAt = event.at;
    }
    await this.store.saveJob(job);
  }

  async #storeResult(job, result) {
    job.state = result.state;
    job.providerJobId = result.providerJobId ?? null;
    job.exitCode = result.exitCode ?? null;
    job.terminalReason = result.terminalReason ?? null;
    job.completedAt = result.completedAt ?? this.#now();
    job.updatedAt = job.completedAt;

    for (const artifact of result.artifacts ?? []) {
      await this.#storeArtifact(job.id, artifact);
    }

    job.artifactCount = (await this.listJobArtifacts(job.id)).length;
    await this.store.saveJob(job);
    this.metrics?.recordJobFinished?.({
      executionMode: job.executionMode,
      provider: job.provider,
      state: job.state,
      durationMs: durationMs(job.createdAt, job.completedAt),
    });
  }

  async #failJob(job, error) {
    const completedAt = this.#now();
    const result = {
      id: job.id,
      state: JobState.Failed,
      executionMode: job.executionMode,
      sessionId: job.sessionId,
      provider: this.provider.name,
      providerJobId: null,
      exitCode: null,
      stderr: error?.message ?? String(error),
      stdout: '',
      artifacts: [],
      events: [],
      completedAt,
    };

    await this.#storeEvent(job.id, {
      type: 'job.final',
      state: JobState.Failed,
      exitCode: null,
      artifactCount: 0,
      error: result.stderr,
    });
    await this.#storeResult(job, result);

    return {
      ...result,
      events: await this.listJobEvents(job.id),
    };
  }

  #now() {
    return this.clock().toISOString();
  }
}

function durationMs(startedAt, completedAt) {
  const started = Date.parse(startedAt);
  const completed = Date.parse(completedAt);
  if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started) {
    return 0;
  }
  return completed - started;
}
