import { createHash, createHmac, randomUUID } from 'node:crypto';

import {
  ArtifactKind,
  ExecutionMode,
  JobState,
  SessionState,
  assertSandboxConfiguration,
  assertExecutionJobRequest,
  createEvent,
  normalizeSandboxConfiguration,
} from '../core/provider-contract.js';
import { redactGitCredentialMaterial } from '../security/git-credentials.js';
import { KubernetesApiClient } from './kubernetes-api.js';

const DEFAULT_IMAGE = 'ghcr.io/limmy/partners-sandbox:local';
const DEFAULT_NAMESPACE = process.env.PARTNERS_K8S_NAMESPACE ?? 'partners-sandbox';
const DEFAULT_PULL_POLICY = process.env.PARTNERS_K8S_IMAGE_PULL_POLICY ?? 'IfNotPresent';

/**
 * Kubernetes-native sandbox provider.
 *
 * A sandbox is a regular, non-privileged Pod plus an internal ClusterIP
 * Service. The gateway talks to the sandbox-agent HTTP API; no kube exec,
 * Docker socket, Sysbox, or host mounts are required.
 */
export class KubernetesSandboxProvider {
  name = 'kubernetes';

  constructor({
    apiClient = null,
    namespace = DEFAULT_NAMESPACE,
    image = process.env.PARTNERS_K8S_SANDBOX_IMAGE ?? DEFAULT_IMAGE,
    allowedRegistries = parseList(process.env.PARTNERS_K8S_ALLOWED_REGISTRIES),
    allowedProfiles = parseList(process.env.PARTNERS_K8S_ALLOWED_PROFILES),
    sandboxProfiles = parseProfiles(process.env.PARTNERS_K8S_SANDBOX_PROFILES),
    requireImageDigest = true,
    requireRegistryAllowlist = true,
    imagePullPolicy = DEFAULT_PULL_POLICY,
    imagePullSecretResolver = defaultImagePullSecretResolver,
    runtimeClassName = process.env.PARTNERS_K8S_RUNTIME_CLASS || null,
    agentSecret = process.env.PARTNERS_K8S_AGENT_SECRET,
    serviceAccountName = process.env.PARTNERS_K8S_SANDBOX_SERVICE_ACCOUNT || null,
    sessionStorageClass = process.env.PARTNERS_K8S_SESSION_STORAGE_CLASS || null,
    startupTimeoutSeconds = Number(process.env.PARTNERS_K8S_STARTUP_TIMEOUT_SECONDS ?? 90),
    fetchImpl = fetch,
    clock = () => new Date(),
  } = {}) {
    if (!agentSecret || agentSecret.length < 32) {
      throw new TypeError('KubernetesSandboxProvider requires PARTNERS_K8S_AGENT_SECRET with at least 32 characters');
    }
    this.api = apiClient ?? KubernetesApiClient.fromEnvironment();
    this.namespace = namespace;
    this.image = image;
    this.allowedRegistries = [...allowedRegistries];
    this.allowedProfiles = [...allowedProfiles];
    this.sandboxProfiles = sandboxProfiles;
    this.requireImageDigest = requireImageDigest;
    this.requireRegistryAllowlist = requireRegistryAllowlist;
    this.imagePullPolicy = imagePullPolicy;
    this.imagePullSecretResolver = imagePullSecretResolver;
    this.runtimeClassName = runtimeClassName;
    this.agentSecret = agentSecret;
    this.serviceAccountName = serviceAccountName;
    this.sessionStorageClass = sessionStorageClass;
    this.startupTimeoutSeconds = startupTimeoutSeconds;
    this.fetch = fetchImpl;
    this.clock = clock;
    this.sessions = new Map();
    this.activeJobs = new Map();
    this.sequence = 0;
  }

  async createSession(request = {}) {
    assertSandboxConfiguration(request.sandbox);
    const id = request.id ?? `ses_${randomUUID()}`;
    const sandbox = await this.#ensureSandbox({ id, request, kind: 'session' });
    try {
      await this.#runInitialization(sandbox, sandbox.config?.init);
      const session = {
        id,
        state: SessionState.Ready,
        executionMode: ExecutionMode.WorkspaceSession,
        provider: this.name,
        providerSessionId: sandbox.id,
        resources: request.resources ?? {},
        persistence: request.persistence ?? (this.sessionStorageClass
          ? { kind: 'pvc', storageClass: this.sessionStorageClass }
          : { kind: 'pod-emptydir' }),
        sandboxConfig: sandbox.config,
        createdAt: this.#now().toISOString(),
        updatedAt: this.#now().toISOString(),
        sandboxName: sandbox.name,
      };
      this.sessions.set(id, { ...session, sandbox });
      return publicSession(session);
    } catch (error) {
      await this.#deleteSandbox(sandbox).catch(() => {});
      throw error;
    }
  }

  async getSession(sessionId) {
    const cached = this.sessions.get(sessionId);
    if (cached) {
      return publicSession(cached);
    }
    const session = await this.#loadSession(sessionId);
    return session ? publicSession(session) : null;
  }

  async deleteSession(sessionId) {
    const record = this.sessions.get(sessionId) ?? await this.#loadSession(sessionId);
    if (!record) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    await this.#deleteSandbox(record.sandbox);
    record.state = SessionState.Deleted;
    record.updatedAt = this.#now().toISOString();
    this.sessions.delete(sessionId);
    return publicSession(record);
  }

  async runJob(request, onEvent = () => {}) {
    assertExecutionJobRequest(request);
    const jobId = request.id ?? `job_${randomUUID()}`;
    const events = [];
    const activeJob = { cancelRequested: false, cancel: null };
    const emit = (type, payload = {}) => {
      const event = createEvent(type, { jobId, ...payload }, ++this.sequence);
      events.push(event);
      onEvent(event);
    };

    let sandbox;
    let session;
    let ephemeral = false;
    this.activeJobs.set(jobId, activeJob);
    try {
      emit('job.state', { state: JobState.Preparing });
      if (request.executionMode === ExecutionMode.WorkspaceSession) {
        session = this.sessions.get(request.sessionId) ?? await this.#loadSession(request.sessionId);
        if (!session) {
          throw new Error(`Session not found: ${request.sessionId}`);
        }
        session.state = SessionState.Busy;
        session.updatedAt = this.#now().toISOString();
        sandbox = session.sandbox;
        this.#assertSessionSandboxOverride(session, request.sandbox);
      } else {
        sandbox = await this.#ensureSandbox({ id: jobId, request, kind: 'job' });
        ephemeral = true;
      }

      activeJob.cancel = () => this.#agentRequest(sandbox, '/v1/cancel', { method: 'POST', body: {} });
      await this.#writeInputs(sandbox, request.inputs);
      await this.#cloneRepository(sandbox, request);
      await this.#runInitialization(sandbox, sandbox.config?.init, emit);
      emit('job.state', { state: JobState.Running });

      const command = request.command ?? codeToCommand(request.code);
      const result = await this.#agentRequest(sandbox, '/v1/exec', {
        method: 'POST',
        body: {
          argv: command.argv,
          cwd: command.cwd,
          env: command.env,
          timeoutSeconds: request.timeoutSeconds,
        },
        timeoutSeconds: request.timeoutSeconds + 30,
      });
      const stdout = result.stdout ?? '';
      const stderr = result.stderr ?? '';
      if (stdout) emit('log.stdout', { chunk: stdout });
      if (stderr) emit('log.stderr', { chunk: stderr });

      const artifacts = await this.#collectArtifacts({ jobId, sandbox, stdout, stderr, policy: request.artifactPolicy, emit });
      const state = activeJob.cancelRequested || result.cancelled
        ? JobState.Cancelled
        : result.timedOut
          ? JobState.TimedOut
          : result.exitCode === 0 ? JobState.Succeeded : JobState.Failed;
      for (const artifact of artifacts) emit('artifact.created', { artifact });
      emit('job.final', { state, exitCode: result.exitCode, artifactCount: artifacts.length });

      return {
        id: jobId,
        state,
        executionMode: request.executionMode,
        sessionId: request.sessionId ?? null,
        provider: this.name,
        providerJobId: result.id ?? null,
        exitCode: result.exitCode,
        terminalReason: state === JobState.Succeeded ? null : state,
        stdout,
        stderr,
        artifacts,
        events,
        completedAt: this.#now().toISOString(),
      };
    } catch (error) {
      const state = activeJob.cancelRequested ? JobState.Cancelled : JobState.Failed;
      const stderr = redactGitCredentialMaterial(error?.message ?? String(error));
      emit('log.stderr', { chunk: stderr });
      emit('job.final', { state, exitCode: null, artifactCount: 0, error: stderr });
      return {
        id: jobId,
        state,
        executionMode: request.executionMode,
        sessionId: request.sessionId ?? null,
        provider: this.name,
        providerJobId: null,
        exitCode: null,
        terminalReason: stderr,
        stdout: '',
        stderr,
        artifacts: [],
        events,
        completedAt: this.#now().toISOString(),
      };
    } finally {
      this.activeJobs.delete(jobId);
      if (session && session.state !== SessionState.Deleted) {
        session.state = SessionState.Ready;
        session.updatedAt = this.#now().toISOString();
      }
      if (ephemeral && sandbox) {
        try {
          await this.#deleteSandbox(sandbox);
        } catch (error) {
          emit('sandbox.cleanup.failed', { error: error.message });
        }
      }
    }
  }

  async cancel(jobId, reason = 'cancelled') {
    const activeJob = this.activeJobs.get(jobId);
    if (!activeJob) return;
    activeJob.cancelRequested = true;
    activeJob.cancelReason = reason;
    await activeJob.cancel?.();
  }

  async reconcile() {
    const [podList, serviceList] = await Promise.all([
      this.api.listPods(this.namespace, 'app=partners-sandbox'),
      this.api.listServices(this.namespace, 'app=partners-sandbox'),
    ]);
    const pods = podList?.items ?? [];
    const podNames = new Set(pods.map((pod) => pod.metadata?.name).filter(Boolean));
    const removedNames = new Set();
    let removedPods = 0;
    let removedServices = 0;

    for (const pod of pods) {
      const name = pod.metadata?.name;
      const kind = pod.metadata?.labels?.['partners.dev/kind'];
      const expiresAt = pod.metadata?.annotations?.['partners.dev/expires-at'];
      const expired = expiresAt && Date.parse(expiresAt) <= this.#now().getTime();
      const terminal = ['Failed', 'Succeeded'].includes(pod.status?.phase);
      if (name && kind === 'job' && (expired || terminal)) {
        await this.#deleteSandbox({ name, persistent: false });
        podNames.delete(name);
        removedNames.add(name);
        removedPods += 1;
      }
    }

    for (const service of serviceList?.items ?? []) {
      const name = service.metadata?.name;
      if (name && !podNames.has(name) && !removedNames.has(name)) {
        await this.api.deleteService(this.namespace, name).catch((error) => {
          if (error.statusCode !== 404) throw error;
        });
        removedServices += 1;
      }
    }
    return { removedPods, removedServices };
  }

  async #ensureSandbox({ id, request, kind }) {
    const config = this.#resolveSandboxConfig(request.sandbox);
    const existing = await this.#discoverSandbox(id, kind);
    if (existing) {
      const existingConfig = this.#sandboxConfigFromPod(existing);
      this.#assertCompatibleSandboxConfig(existingConfig, config, id);
      const ready = await this.#waitForReady(existing.metadata?.name ?? sandboxName(kind, id));
      const sandbox = this.#sandboxRecord(id, kind, ready);
      await this.#waitForAgent(sandbox);
      return sandbox;
    }
    const name = sandboxName(kind, id);
    const labels = {
      app: 'partners-sandbox',
      'partners.dev/kind': kind,
      'partners.dev/id-hash': idHash(id).slice(0, 32),
    };
    const annotations = {
      'partners.dev/id': id,
      'partners.dev/created-at': this.#now().toISOString(),
    };
    const resources = resourceSpec(request.resources ?? {});
    const persistent = kind === 'session' && Boolean(
      request.persistence?.kind === 'pvc' || this.sessionStorageClass,
    );
    const existingClaim = persistent ? await this.#discoverPersistentVolumeClaim(name) : null;
    if (persistent) {
      annotations['partners.dev/storage'] = 'pvc';
      if (existingClaim?.metadata?.annotations) {
        for (const key of [
          'partners.dev/init-hash',
          'partners.dev/init-status',
          'partners.dev/init-version',
          'partners.dev/init-idempotency-key',
        ]) {
          if (existingClaim.metadata.annotations[key]) {
            annotations[key] = existingClaim.metadata.annotations[key];
          }
        }
      }
    }
    if (kind === 'job') {
      const ttlSeconds = Math.ceil(positive(request.timeoutSeconds, 120) + this.startupTimeoutSeconds + 60);
      annotations['partners.dev/expires-at'] = new Date(this.#now().getTime() + ttlSeconds * 1000).toISOString();
    }
    this.#applySandboxAnnotations(annotations, config);
    const image = config?.image ?? this.image;
    const imagePullPolicy = config?.imagePullPolicy ?? this.imagePullPolicy;
    const imagePullSecretName = config?.imagePullSecretRef
      ? this.imagePullSecretResolver(config.imagePullSecretRef)
      : null;
    if (config?.imagePullSecretRef && !isKubernetesSecretName(imagePullSecretName)) {
      throw new TypeError('sandbox.imagePullSecretRef could not be resolved by the platform');
    }
    const pod = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name, labels, annotations },
      spec: {
        restartPolicy: kind === 'job' ? 'Never' : 'Always',
        terminationGracePeriodSeconds: 5,
        ...(kind === 'job' ? {
          activeDeadlineSeconds: Math.ceil(positive(request.timeoutSeconds, 120) + this.startupTimeoutSeconds + 60),
        } : {}),
        automountServiceAccountToken: false,
        ...(this.runtimeClassName ? { runtimeClassName: this.runtimeClassName } : {}),
        ...(this.serviceAccountName ? { serviceAccountName: this.serviceAccountName } : {}),
        ...(config?.architecture ? { nodeSelector: { 'kubernetes.io/arch': config.architecture } } : {}),
        securityContext: {
          runAsNonRoot: true,
          runAsUser: 1000,
          runAsGroup: 1000,
          fsGroup: 1000,
          seccompProfile: { type: 'RuntimeDefault' },
        },
        containers: [{
          name: 'sandbox',
          image,
          imagePullPolicy,
          ports: [{ name: 'agent', containerPort: 8081 }],
          readinessProbe: {
            httpGet: { path: '/health', port: 'agent' },
            periodSeconds: 1,
            timeoutSeconds: 1,
            failureThreshold: 30,
          },
          livenessProbe: {
            httpGet: { path: '/health', port: 'agent' },
            initialDelaySeconds: 10,
            periodSeconds: 10,
            timeoutSeconds: 2,
            failureThreshold: 3,
          },
          env: [
            { name: 'SANDBOX_AGENT_TOKEN', value: this.#agentToken(id) },
            { name: 'SANDBOX_WORKSPACE', value: '/workspace' },
          ],
          resources: resources.container,
          securityContext: {
            allowPrivilegeEscalation: false,
            readOnlyRootFilesystem: false,
            capabilities: { drop: ['ALL'] },
          },
          volumeMounts: [{ name: 'workspace', mountPath: '/workspace' }],
        }],
        ...(imagePullSecretName ? { imagePullSecrets: [{ name: imagePullSecretName }] } : {}),
        volumes: [persistent
          ? { name: 'workspace', persistentVolumeClaim: { claimName: name } }
          : {
            name: 'workspace',
            emptyDir: {
              medium: '',
              ...(resources.disk ? { sizeLimit: resources.disk } : {}),
            },
          }],
      },
    };

    try {
      if (persistent && !existingClaim) {
        await this.api.createPersistentVolumeClaim(this.namespace, {
          apiVersion: 'v1',
          kind: 'PersistentVolumeClaim',
          metadata: { name, labels, annotations },
          spec: {
            accessModes: ['ReadWriteOnce'],
            ...(this.sessionStorageClass ? { storageClassName: this.sessionStorageClass } : {}),
            resources: { requests: { storage: resources.disk } },
          },
        });
      }
      await this.api.createPod(this.namespace, pod);
      await this.api.createService(this.namespace, {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: { name, labels },
        spec: {
          type: 'ClusterIP',
          selector: labels,
          ports: [{ name: 'agent', port: 8081, targetPort: 'agent' }],
        },
      }).catch((error) => {
        if (error.statusCode !== 409) throw error;
      });
      const status = await this.#waitForReady(name);
      const sandbox = this.#sandboxRecord(id, kind, status);
      await this.#waitForAgent(sandbox);
      return sandbox;
    } catch (error) {
      await this.#deleteSandbox({ name, persistent, preservePersistentVolumeClaim: Boolean(existingClaim) }).catch(() => {});
      throw error;
    }
  }

  async #waitForReady(name) {
    const deadline = Date.now() + this.startupTimeoutSeconds * 1000;
    let lastStatus = null;
    while (Date.now() < deadline) {
      const pod = await this.api.getPod(this.namespace, name);
      lastStatus = pod.status ?? {};
      if (lastStatus.phase === 'Running' && (lastStatus.conditions ?? []).some((item) => item.type === 'Ready' && item.status === 'True')) {
        return pod;
      }
      if (['Failed', 'Succeeded'].includes(lastStatus.phase)) {
        const logs = await this.api.getPodLogs(this.namespace, name).catch(() => '');
        throw new Error(`Sandbox pod ${name} entered ${lastStatus.phase}: ${logs.slice(-2000)}`);
      }
      await delay(250);
    }
    const logs = await this.api.getPodLogs(this.namespace, name).catch(() => '');
    throw new Error(`Timed out waiting for sandbox pod ${name} (${lastStatus?.phase ?? 'unknown'}): ${logs.slice(-2000)}`);
  }

  async #waitForAgent(sandbox) {
    const deadline = Date.now() + this.startupTimeoutSeconds * 1000;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        const remainingMs = Math.max(1, deadline - Date.now());
        const response = await this.fetch(`${sandbox.endpoint}/health`, {
          signal: AbortSignal.timeout(Math.min(2000, remainingMs)),
        });
        if (response.ok) return;
        lastError = new Error(`HTTP ${response.status}`);
      } catch (error) {
        lastError = error;
      }
      await delay(250);
    }
    const reason = lastError?.cause?.message ?? lastError?.message ?? 'unreachable';
    throw new Error(`Timed out waiting for sandbox agent ${sandbox.name}: ${reason}`);
  }

  async #discoverSandbox(id, kind) {
    try {
      return await this.api.getPod(this.namespace, sandboxName(kind, id));
    } catch (error) {
      if (error.statusCode === 404) return null;
      throw error;
    }
  }

  async #discoverPersistentVolumeClaim(name) {
    try {
      return await this.api.getPersistentVolumeClaim(this.namespace, name);
    } catch (error) {
      if (error.statusCode === 404) return null;
      throw error;
    }
  }

  async #loadSession(sessionId) {
    const pod = await this.#discoverSandbox(sessionId, 'session');
    if (!pod) {
      const claim = await this.#discoverPersistentVolumeClaim(sandboxName('session', sessionId));
      if (!claim) return null;
      const persistedConfig = this.#sandboxConfigFromMetadata(claim.metadata);
      const sandbox = await this.#ensureSandbox({
        id: sessionId,
        request: {
          persistence: { kind: 'pvc' },
          ...(persistedConfig ? { sandbox: persistedConfig } : {}),
        },
        kind: 'session',
      });
      const session = {
        id: sessionId,
        state: SessionState.Ready,
        executionMode: ExecutionMode.WorkspaceSession,
        provider: this.name,
        providerSessionId: sandbox.id,
        resources: {},
        persistence: { kind: 'pvc' },
        sandboxConfig: sandbox.config,
        createdAt: claim.metadata?.creationTimestamp ?? this.#now().toISOString(),
        updatedAt: this.#now().toISOString(),
        sandboxName: sandbox.name,
        sandbox,
      };
      this.sessions.set(sessionId, session);
      return session;
    }
    const sandbox = this.#sandboxRecord(sessionId, 'session', pod);
    const session = {
      id: sessionId,
      state: pod.status?.phase === 'Running' ? SessionState.Ready : SessionState.Provisioning,
      executionMode: ExecutionMode.WorkspaceSession,
      provider: this.name,
      providerSessionId: sandbox.id,
      resources: {},
      persistence: sandbox.persistent ? { kind: 'pvc' } : { kind: 'pod-emptydir' },
      sandboxConfig: sandbox.config,
      createdAt: pod.metadata?.annotations?.['partners.dev/created-at'] ?? this.#now().toISOString(),
      updatedAt: this.#now().toISOString(),
      sandboxName: sandbox.name,
      sandbox,
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  #sandboxRecord(id, kind, pod) {
    const name = pod.metadata?.name ?? sandboxName(kind, id);
    const config = this.#sandboxConfigFromPod(pod);
    return {
      id,
      kind,
      name,
      phase: pod.status?.phase ?? 'Pending',
      createdAt: pod.metadata?.creationTimestamp,
      endpoint: `http://${name}.${this.namespace}.svc:8081`,
      token: this.#agentToken(id),
      config,
      initHash: pod.metadata?.annotations?.['partners.dev/init-hash'] ?? null,
      persistent: pod.metadata?.annotations?.['partners.dev/storage'] === 'pvc'
        || pod.spec?.volumes?.some((volume) => volume.persistentVolumeClaim),
    };
  }

  #resolveSandboxConfig(requested) {
    if (requested === undefined || requested === null) {
      return undefined;
    }
    const normalized = normalizeSandboxConfiguration(requested);
    let profileConfig = {};
    if (normalized?.profile) {
      const profile = this.sandboxProfiles[normalized.profile];
      if (!profile) {
        throw new TypeError(`sandbox.profile is not configured: ${normalized.profile}`);
      }
      profileConfig = normalizeSandboxConfiguration(profile) ?? {};
    }
    const merged = normalizeSandboxConfiguration({ ...profileConfig, ...normalized });
    assertSandboxConfiguration(merged, {
      allowedRegistries: this.allowedRegistries,
      allowedProfiles: this.allowedProfiles,
      requireDigest: this.requireImageDigest,
      requireRegistryAllowlist: this.requireRegistryAllowlist,
    });
    return merged;
  }

  #sandboxConfigFromPod(pod) {
    return this.#sandboxConfigFromMetadata(pod.metadata);
  }

  #sandboxConfigFromMetadata(metadata = {}) {
    const annotations = metadata.annotations ?? {};
    if (![
      'partners.dev/sandbox-image',
      'partners.dev/sandbox-profile',
      'partners.dev/image-pull-secret-ref',
      'partners.dev/image-pull-policy',
      'partners.dev/architecture',
      'partners.dev/init-config',
    ].some((key) => annotations[key])) {
      return undefined;
    }
    const init = annotations['partners.dev/init-config']
      ? parseJsonAnnotation(annotations['partners.dev/init-config'])
      : undefined;
    return normalizeSandboxConfiguration({
      ...(annotations['partners.dev/sandbox-profile'] ? { profile: annotations['partners.dev/sandbox-profile'] } : {}),
      ...(annotations['partners.dev/sandbox-image'] ? { image: annotations['partners.dev/sandbox-image'] } : {}),
      ...(annotations['partners.dev/image-pull-secret-ref'] ? { imagePullSecretRef: annotations['partners.dev/image-pull-secret-ref'] } : {}),
      ...(annotations['partners.dev/image-pull-policy'] ? { imagePullPolicy: annotations['partners.dev/image-pull-policy'] } : {}),
      ...(annotations['partners.dev/architecture'] ? { architecture: annotations['partners.dev/architecture'] } : {}),
      ...(init ? { init } : {}),
    });
  }

  #applySandboxAnnotations(annotations, config) {
    if (!config) return;
    if (config.profile) annotations['partners.dev/sandbox-profile'] = config.profile;
    if (config.image) annotations['partners.dev/sandbox-image'] = config.image;
    if (config.imagePullSecretRef) annotations['partners.dev/image-pull-secret-ref'] = config.imagePullSecretRef;
    if (config.imagePullPolicy) annotations['partners.dev/image-pull-policy'] = config.imagePullPolicy;
    if (config.architecture) annotations['partners.dev/architecture'] = config.architecture;
    if (config.init) annotations['partners.dev/init-config'] = JSON.stringify(config.init);
  }

  #assertCompatibleSandboxConfig(existing, requested, id) {
    if (!requested || !existing) return;
    if (stableJson(existing) !== stableJson(requested)) {
      throw new Error(`Sandbox ${id} already exists with a different immutable configuration`);
    }
  }

  #assertSessionSandboxOverride(session, requested) {
    if (!requested) return;
    const resolved = this.#resolveSandboxConfig(requested);
    this.#assertCompatibleSandboxConfig(session.sandboxConfig ?? session.sandbox?.config, resolved, session.id);
  }

  async #runInitialization(sandbox, init, emit = null) {
    if (!init) return;
    const initHash = createHash('sha256').update(stableJson(init)).digest('hex');
    if (sandbox.initHash === initHash) {
      emit?.('sandbox.init.skipped', { initHash, version: init.version ?? null });
      return;
    }
    emit?.('sandbox.init.started', { initHash, version: init.version ?? null });
    try {
      if (init.files?.length) {
        await this.#writeInputs(sandbox, { files: init.files });
      }
      if (init.argv?.length) {
        let result;
        result = await this.#agentRequest(sandbox, '/v1/exec', {
          method: 'POST',
          body: {
            argv: init.argv,
            cwd: '/workspace',
            env: init.env,
            timeoutSeconds: init.timeoutSeconds ?? 120,
          },
          timeoutSeconds: (init.timeoutSeconds ?? 120) + 30,
        });
        if (result?.cancelled || result?.timedOut || result?.exitCode !== 0) {
          throw new Error(`Sandbox initialization failed (exit code ${result?.exitCode ?? 'unknown'})`);
        }
      }
    } catch (error) {
      emit?.('sandbox.init.failed', { initHash, reason: 'bootstrap_failed' });
      if (/Sandbox initialization failed/.test(error?.message ?? '')) throw error;
      throw new Error('Sandbox initialization failed while applying bootstrap');
    }
    const annotations = {
      'partners.dev/init-hash': initHash,
      'partners.dev/init-status': 'succeeded',
      ...(init.version ? { 'partners.dev/init-version': init.version } : {}),
      ...(init.idempotencyKey ? { 'partners.dev/init-idempotency-key': init.idempotencyKey } : {}),
    };
    if (this.api.patchPod) {
      const current = await this.api.getPod(this.namespace, sandbox.name);
      await this.api.patchPod(this.namespace, sandbox.name, {
        metadata: { annotations: { ...(current.metadata?.annotations ?? {}), ...annotations } },
      });
    }
    if (sandbox.persistent && this.api.patchPersistentVolumeClaim) {
      const current = await this.api.getPersistentVolumeClaim(this.namespace, sandbox.name);
      await this.api.patchPersistentVolumeClaim(this.namespace, sandbox.name, {
        metadata: { annotations: { ...(current.metadata?.annotations ?? {}), ...annotations } },
      });
    }
    sandbox.initHash = initHash;
    emit?.('sandbox.init.succeeded', { initHash, version: init.version ?? null });
  }

  async #deleteSandbox(sandbox) {
    if (!sandbox?.name) return;
    await this.api.deleteService(this.namespace, sandbox.name).catch((error) => {
      if (error.statusCode !== 404) throw error;
    });
    await this.api.deletePod(this.namespace, sandbox.name).catch((error) => {
      if (error.statusCode !== 404) throw error;
    });
    if (sandbox.persistent && !sandbox.preservePersistentVolumeClaim) {
      await this.api.deletePersistentVolumeClaim(this.namespace, sandbox.name).catch((error) => {
        if (error.statusCode !== 404) throw error;
      });
    }
  }

  async #writeInputs(sandbox, inputs = {}) {
    for (const file of inputs.files ?? []) {
      await this.#agentRequest(sandbox, '/v1/files/write', {
        method: 'POST',
        body: {
          path: file.path,
          content: file.content,
          contentBase64: file.contentBase64,
        },
      });
    }
  }

  async #cloneRepository(sandbox, request) {
    if (!request.repository?.url) return;
    const argv = ['git', 'clone'];
    if (request.repository.branch) argv.push('--branch', request.repository.branch);
    argv.push(request.repository.url, request.repository.destination ?? '/workspace/repo');
    await this.#agentRequest(sandbox, '/v1/exec', {
      method: 'POST',
      body: { argv, cwd: '/workspace', timeoutSeconds: request.repository.timeoutSeconds ?? 300 },
      timeoutSeconds: (request.repository.timeoutSeconds ?? 300) + 30,
    });
  }

  async #collectArtifacts({ jobId, sandbox, stdout, stderr, policy = {}, emit }) {
    const artifacts = [];
    if (stdout) artifacts.push(textArtifact(jobId, ArtifactKind.Stdout, 'stdout.txt', stdout));
    if (stderr) artifacts.push(textArtifact(jobId, ArtifactKind.Stderr, 'stderr.txt', stderr));
    for (const item of policy.collect ?? []) {
      if (!item.startsWith('workspace:')) continue;
      const sourcePath = item.slice('workspace:'.length);
      try {
        const response = await this.#agentRequest(sandbox, `/v1/files/read?path=${encodeURIComponent(sourcePath)}`);
        artifacts.push({
          id: `art_${randomUUID()}`,
          jobId,
          kind: ArtifactKind.File,
          name: sourcePath.split('/').filter(Boolean).at(-1) ?? 'artifact',
          contentBase64: response.contentBase64,
          sizeBytes: response.sizeBytes,
          createdAt: this.#now().toISOString(),
        });
      } catch (error) {
        emit('artifact.export.skipped', { path: sourcePath, reason: error.message });
      }
    }
    return artifacts;
  }

  async #agentRequest(sandbox, path, { method = 'GET', body, timeoutSeconds = 30 } = {}) {
    const response = await this.fetch(`${sandbox.endpoint}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${sandbox.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutSeconds * 1000),
    });
    const text = await response.text();
    let parsed;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    if (!response.ok) {
      throw Object.assign(new Error(parsed?.error ?? `Sandbox agent request failed: ${response.status}`), {
        statusCode: response.status,
      });
    }
    return parsed;
  }

  #agentToken(id) {
    return createHmac('sha256', this.agentSecret).update(id).digest('hex');
  }

  #now() { return this.clock(); }
}

function publicSession(session) {
  const { sandbox: _sandbox, sandboxConfig, ...rest } = session;
  return {
    ...rest,
    ...(sandboxConfig ? { sandbox: sandboxConfig } : {}),
  };
}

function sandboxName(kind, id) {
  const prefix = kind === 'session' ? 'partners-session-' : 'partners-job-';
  return `${prefix}${idHash(id).slice(0, 24)}`;
}

function idHash(id) {
  return createHmac('sha256', 'partners-name').update(String(id)).digest('hex');
}

function resourceSpec(resources) {
  const cpu = positive(resources.cpu, 1);
  const memory = `${positive(resources.memoryGiB, 1)}Gi`;
  const disk = `${positive(resources.diskGiB, 3)}Gi`;
  return {
    container: {
      requests: { cpu: String(cpu), memory, 'ephemeral-storage': disk },
      limits: { cpu: String(cpu), memory, 'ephemeral-storage': disk },
    },
    disk,
  };
}

function positive(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function textArtifact(jobId, kind, name, content) {
  return {
    id: `art_${randomUUID()}`,
    jobId,
    kind,
    name,
    contentBase64: Buffer.from(content).toString('base64'),
    sizeBytes: Buffer.byteLength(content),
    createdAt: new Date().toISOString(),
  };
}

function codeToCommand(code) {
  if (!code) throw new TypeError('Missing command or code');
  if (code.language === 'python') return { argv: ['python3', '-c', code.source] };
  if (code.language === 'javascript') return { argv: ['node', '-e', code.source] };
  if (code.language === 'shell') return { argv: ['bash', '-lc', code.source] };
  throw new TypeError(`Unsupported code language: ${code.language}`);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseList(value) {
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseProfiles(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    throw new TypeError('PARTNERS_K8S_SANDBOX_PROFILES must be valid JSON');
  }
}

function defaultImagePullSecretResolver(reference) {
  const value = String(reference ?? '');
  const name = value.split('/').filter(Boolean).at(-1) ?? '';
  return isKubernetesSecretName(name) ? name : null;
}

function isKubernetesSecretName(value) {
  return typeof value === 'string'
    && value.length <= 253
    && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value);
}

function parseJsonAnnotation(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}
