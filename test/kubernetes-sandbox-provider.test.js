import assert from 'node:assert/strict';
import test from 'node:test';

import { ExecutionMode, KubernetesSandboxProvider } from '../src/index.js';

test('creates a non-privileged Pod sandbox and removes ephemeral jobs', async () => {
  const api = new FakeApi();
  const fetch = createFakeAgentFetch();
  const provider = new KubernetesSandboxProvider({
    apiClient: api,
    namespace: 'partners-sandbox',
    image: 'registry.example/partners-sandbox:test',
    agentSecret: 'a'.repeat(32),
    fetchImpl: fetch,
  });

  const result = await provider.runJob({
    id: 'job_test',
    executionMode: ExecutionMode.EphemeralInterpreter,
    inputs: { files: [{ path: '/workspace/input.txt', content: 'hello' }] },
    command: { argv: ['python3', '-c', 'print(1)'] },
    timeoutSeconds: 5,
    artifactPolicy: { collect: ['workspace:/workspace/input.txt'] },
  });

  assert.equal(result.state, 'succeeded');
  assert.equal(Buffer.from(result.artifacts.at(-1).contentBase64, 'base64').toString(), 'hello');
  assert.equal(api.pods.size, 0);
  assert.equal(api.services.size, 0);
  const pod = api.createdPods[0];
  assert.equal(pod.spec.containers[0].securityContext.allowPrivilegeEscalation, false);
  assert.deepEqual(pod.spec.containers[0].securityContext.capabilities.drop, ['ALL']);
  assert.equal(pod.spec.automountServiceAccountToken, false);
  assert.equal(pod.spec.containers[0].securityContext.privileged, undefined);
  assert.ok(pod.spec.activeDeadlineSeconds > 5);
});

test('waits for the sandbox Service to become reachable before sending work', async () => {
  const api = new FakeApi();
  const agentFetch = createFakeAgentFetch();
  let healthAttempts = 0;
  const provider = new KubernetesSandboxProvider({
    apiClient: api,
    namespace: 'partners-sandbox',
    agentSecret: 'r'.repeat(32),
    fetchImpl: async (url, options) => {
      if (new URL(url).pathname === '/health' && healthAttempts++ < 2) {
        throw new TypeError('fetch failed', { cause: new Error('service endpoint is not ready') });
      }
      return agentFetch(url, options);
    },
  });

  const result = await provider.runJob({
    id: 'job_service_race',
    executionMode: ExecutionMode.EphemeralInterpreter,
    command: { argv: ['node', '-e', 'console.log("ready")'] },
    timeoutSeconds: 5,
  });

  assert.equal(result.state, 'succeeded');
  assert.equal(healthAttempts, 3);
});

test('reuses a workspace session without a privileged runtime', async () => {
  const api = new FakeApi();
  const fetch = createFakeAgentFetch();
  const provider = new KubernetesSandboxProvider({
    apiClient: api,
    namespace: 'partners-sandbox',
    agentSecret: 'b'.repeat(32),
    sessionStorageClass: 'fast-block',
    fetchImpl: fetch,
  });

  const session = await provider.createSession({ id: 'ses_test' });
  const restartedProvider = new KubernetesSandboxProvider({
    apiClient: api,
    namespace: 'partners-sandbox',
    agentSecret: 'b'.repeat(32),
    sessionStorageClass: 'fast-block',
    fetchImpl: fetch,
  });
  const discovered = await restartedProvider.getSession(session.id);
  assert.equal(discovered.providerSessionId, session.id);
  assert.equal(discovered.sandboxName, session.sandboxName);
  assert.equal(discovered.persistence.kind, 'pvc');
  const first = await provider.runJob({
    executionMode: ExecutionMode.WorkspaceSession,
    sessionId: session.id,
    inputs: { files: [{ path: 'persist.txt', content: 'yes' }] },
    command: { argv: ['bash', '-lc', 'true'] },
    timeoutSeconds: 5,
  });
  const second = await provider.runJob({
    executionMode: ExecutionMode.WorkspaceSession,
    sessionId: session.id,
    command: { argv: ['bash', '-lc', 'cat persist.txt'] },
    timeoutSeconds: 5,
  });

  assert.equal(first.state, 'succeeded');
  assert.equal(second.state, 'succeeded');
  assert.match(second.stdout, /yes/);
  assert.equal(api.pods.size, 1);
  assert.equal(api.claims.size, 1);
  await provider.deleteSession(session.id);
  assert.equal(api.pods.size, 0);
  assert.equal(api.claims.size, 0);
});

test('recreates a deleted session Pod from its retained PVC', async () => {
  const api = new FakeApi();
  const fetch = createFakeAgentFetch();
  const provider = new KubernetesSandboxProvider({
    apiClient: api,
    namespace: 'partners-sandbox',
    agentSecret: 'p'.repeat(32),
    sessionStorageClass: 'partners-juicefs-rustfs',
    fetchImpl: fetch,
  });
  const session = await provider.createSession({ id: 'ses_recover' });
  await provider.runJob({
    executionMode: ExecutionMode.WorkspaceSession,
    sessionId: session.id,
    command: { argv: ['node', '-e', "require('fs').writeFileSync('persist.txt','yes')"] },
    timeoutSeconds: 5,
  });
  await api.deletePod('partners-sandbox', session.sandboxName);

  const restarted = new KubernetesSandboxProvider({
    apiClient: api,
    namespace: 'partners-sandbox',
    agentSecret: 'p'.repeat(32),
    sessionStorageClass: 'partners-juicefs-rustfs',
    fetchImpl: fetch,
  });
  const recovered = await restarted.getSession(session.id);
  const result = await restarted.runJob({
    executionMode: ExecutionMode.WorkspaceSession,
    sessionId: session.id,
    command: { argv: ['bash', '-lc', 'cat persist.txt'] },
    timeoutSeconds: 5,
  });

  assert.equal(recovered.state, 'ready');
  assert.equal(recovered.persistence.kind, 'pvc');
  assert.equal(result.state, 'succeeded');
  assert.equal(api.claims.size, 1);
  assert.equal(api.pods.size, 1);
});

test('reconciles expired jobs and orphan Services without deleting sessions', async () => {
  const api = new FakeApi();
  api.pods.set('partners-sandbox/expired-job', sandboxResource('Pod', 'expired-job', 'job', {
    phase: 'Running',
    expiresAt: '2020-01-01T00:00:00.000Z',
  }));
  api.pods.set('partners-sandbox/live-session', sandboxResource('Pod', 'live-session', 'session', {
    phase: 'Running',
  }));
  api.services.set('partners-sandbox/expired-job', sandboxResource('Service', 'expired-job', 'job'));
  api.services.set('partners-sandbox/orphan', sandboxResource('Service', 'orphan', 'job'));

  const provider = new KubernetesSandboxProvider({
    apiClient: api,
    namespace: 'partners-sandbox',
    agentSecret: 'c'.repeat(32),
    fetchImpl: createFakeAgentFetch(),
    clock: () => new Date('2026-08-12T00:00:00.000Z'),
  });
  const result = await provider.reconcile();

  assert.equal(result.removedPods, 1);
  assert.equal(result.removedServices, 1);
  assert.equal(api.pods.has('partners-sandbox/expired-job'), false);
  assert.equal(api.pods.has('partners-sandbox/live-session'), true);
  assert.equal(api.services.has('partners-sandbox/orphan'), false);
});

test('builds a policy-bound custom image Pod and runs bootstrap before the job', async () => {
  const api = new FakeApi();
  const executions = [];
  const events = [];
  const baseFetch = createFakeAgentFetch();
  const fetch = async (url, options = {}) => {
    if (new URL(url).pathname === '/v1/exec') {
      executions.push(JSON.parse(options.body));
    }
    return baseFetch(url, options);
  };
  const provider = new KubernetesSandboxProvider({
    apiClient: api,
    namespace: 'partners-sandbox',
    agentSecret: 'custom'.repeat(8),
    allowedRegistries: ['registry.example'],
    fetchImpl: fetch,
  });

  const result = await provider.runJob({
    id: 'job_custom_image',
    executionMode: ExecutionMode.EphemeralInterpreter,
    sandbox: {
      image: `registry.example/partners/tools@sha256:${'d'.repeat(64)}`,
      imagePullSecretRef: 'platform://registry/partners',
      imagePullPolicy: 'Always',
      architecture: 'arm64',
      init: {
        files: [{ path: '/workspace/bootstrap.sh', content: '#!/bin/sh\n' }],
        argv: ['/workspace/bootstrap.sh'],
        env: { BOOTSTRAP: '1' },
        timeoutSeconds: 15,
        version: 'v1',
      },
    },
    command: { argv: ['node', '-e', 'console.log("main")'] },
    timeoutSeconds: 5,
  }, (event) => events.push(event));

  assert.equal(result.state, 'succeeded');
  assert.equal(executions.length, 2);
  assert.deepEqual(executions[0].argv, ['/workspace/bootstrap.sh']);
  assert.equal(executions[0].env.BOOTSTRAP, '1');
  assert.deepEqual(executions[1].argv, ['node', '-e', 'console.log("main")']);
  assert.ok(events.some((event) => event.type === 'sandbox.init.started'));
  assert.ok(events.some((event) => event.type === 'sandbox.init.succeeded'));
  const pod = api.createdPods[0];
  assert.equal(pod.spec.containers[0].image, `registry.example/partners/tools@sha256:${'d'.repeat(64)}`);
  assert.equal(pod.spec.containers[0].imagePullPolicy, 'Always');
  assert.deepEqual(pod.spec.imagePullSecrets, [{ name: 'partners' }]);
  assert.deepEqual(pod.spec.nodeSelector, { 'kubernetes.io/arch': 'arm64' });
  assert.equal(api.pods.size, 0);
});

test('resolves an authorized sandbox profile before constructing the Pod', async () => {
  const api = new FakeApi();
  const provider = new KubernetesSandboxProvider({
    apiClient: api,
    namespace: 'partners-sandbox',
    agentSecret: 'profile'.repeat(5),
    allowedRegistries: ['registry.example'],
    allowedProfiles: ['python-tools'],
    sandboxProfiles: {
      'python-tools': {
        image: `registry.example/partners/python@sha256:${'1'.repeat(64)}`,
        imagePullSecretRef: 'platform://registry/partners',
        architecture: 'amd64',
      },
    },
    fetchImpl: createFakeAgentFetch(),
  });
  const result = await provider.runJob({
    id: 'job_profile',
    executionMode: ExecutionMode.EphemeralInterpreter,
    sandbox: { profile: 'python-tools' },
    command: { argv: ['true'] },
    timeoutSeconds: 5,
  });

  assert.equal(result.state, 'succeeded');
  assert.equal(api.createdPods[0].spec.containers[0].image, `registry.example/partners/python@sha256:${'1'.repeat(64)}`);
  assert.deepEqual(api.createdPods[0].spec.imagePullSecrets, [{ name: 'partners' }]);
});

test('persists successful session bootstrap across Pod recreation and PVC recovery', async () => {
  const api = new FakeApi();
  let initCalls = 0;
  const baseFetch = createFakeAgentFetch();
  const fetch = async (url, options = {}) => {
    if (new URL(url).pathname === '/v1/exec') {
      const body = JSON.parse(options.body);
      if (body.argv?.[0] === '/workspace/bootstrap.sh') initCalls += 1;
    }
    return baseFetch(url, options);
  };
  const sandbox = {
    image: `registry.example/partners/tools@sha256:${'e'.repeat(64)}`,
    init: {
      files: [{ path: '/workspace/bootstrap.sh', content: '#!/bin/sh\n' }],
      argv: ['/workspace/bootstrap.sh'],
      timeoutSeconds: 15,
      idempotencyKey: 'session-bootstrap-v1',
      version: 'v1',
    },
  };
  const provider = new KubernetesSandboxProvider({
    apiClient: api,
    namespace: 'partners-sandbox',
    sessionStorageClass: 'fast-block',
    allowedRegistries: ['registry.example'],
    agentSecret: 'persist'.repeat(5),
    fetchImpl: fetch,
  });

  const session = await provider.createSession({ id: 'ses_custom', sandbox });
  assert.equal(initCalls, 1);
  await provider.runJob({
    executionMode: ExecutionMode.WorkspaceSession,
    sessionId: session.id,
    command: { argv: ['true'] },
    timeoutSeconds: 5,
  });
  assert.equal(initCalls, 1);
  await api.deletePod('partners-sandbox', session.sandboxName);

  const restarted = new KubernetesSandboxProvider({
    apiClient: api,
    namespace: 'partners-sandbox',
    sessionStorageClass: 'fast-block',
    allowedRegistries: ['registry.example'],
    agentSecret: 'persist'.repeat(5),
    fetchImpl: fetch,
  });
  await restarted.getSession(session.id);
  await restarted.runJob({
    executionMode: ExecutionMode.WorkspaceSession,
    sessionId: session.id,
    command: { argv: ['true'] },
    timeoutSeconds: 5,
  });
  assert.equal(initCalls, 1);
});

test('fails closed and cleans up an ephemeral Pod when bootstrap exits non-zero', async () => {
  const api = new FakeApi();
  const baseFetch = createFakeAgentFetch();
  const fetch = async (url, options = {}) => {
    if (new URL(url).pathname === '/v1/exec' && JSON.parse(options.body).argv?.[0] === '/workspace/fail.sh') {
      return response({ ok: true, id: 'init_fail', exitCode: 7, stdout: 'secret-output', stderr: 'failed' });
    }
    return baseFetch(url, options);
  };
  const provider = new KubernetesSandboxProvider({
    apiClient: api,
    namespace: 'partners-sandbox',
    allowedRegistries: ['registry.example'],
    agentSecret: 'failure'.repeat(5),
    fetchImpl: fetch,
  });
  const result = await provider.runJob({
    id: 'job_init_failure',
    executionMode: ExecutionMode.EphemeralInterpreter,
    sandbox: {
      image: `registry.example/partners/tools@sha256:${'f'.repeat(64)}`,
      init: { argv: ['/workspace/fail.sh'], timeoutSeconds: 5 },
    },
    command: { argv: ['true'] },
    timeoutSeconds: 5,
  });

  assert.equal(result.state, 'failed');
  assert.match(result.stderr, /initialization failed/);
  assert.doesNotMatch(result.stderr, /secret-output/);
  assert.equal(api.pods.size, 0);
  assert.equal(api.services.size, 0);
});

test('fails closed on bootstrap timeout and does not leak the agent output', async () => {
  const api = new FakeApi();
  const baseFetch = createFakeAgentFetch();
  const fetch = async (url, options = {}) => {
    if (new URL(url).pathname === '/v1/exec' && JSON.parse(options.body).argv?.[0] === '/workspace/slow.sh') {
      return response({ ok: true, id: 'init_timeout', exitCode: null, timedOut: true, stdout: 'sensitive-output' });
    }
    return baseFetch(url, options);
  };
  const provider = new KubernetesSandboxProvider({
    apiClient: api,
    namespace: 'partners-sandbox',
    allowedRegistries: ['registry.example'],
    agentSecret: 'timeout'.repeat(5),
    fetchImpl: fetch,
  });
  const result = await provider.runJob({
    id: 'job_init_timeout',
    executionMode: ExecutionMode.EphemeralInterpreter,
    sandbox: {
      image: `registry.example/partners/tools@sha256:${'2'.repeat(64)}`,
      init: { argv: ['/workspace/slow.sh'], timeoutSeconds: 1 },
    },
    command: { argv: ['true'] },
    timeoutSeconds: 5,
  });

  assert.equal(result.state, 'failed');
  assert.match(result.stderr, /initialization failed/);
  assert.doesNotMatch(result.stderr, /sensitive-output/);
  assert.equal(api.pods.size, 0);
});

test('cancels a bootstrap execution and cleans the ephemeral Pod', async () => {
  const api = new FakeApi();
  const baseFetch = createFakeAgentFetch();
  let releaseExecution;
  let cancelled = false;
  let notifyStarted;
  const started = new Promise((resolve) => { notifyStarted = resolve; });
  const fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/v1/exec' && JSON.parse(options.body).argv?.[0] === '/workspace/wait.sh') {
      const waitForCancel = new Promise((resolve) => { releaseExecution = resolve; });
      notifyStarted();
      await waitForCancel;
      return response({ ok: true, id: 'init_cancel', exitCode: null, cancelled });
    }
    if (parsed.pathname === '/v1/cancel') {
      cancelled = true;
      releaseExecution?.();
      return response({ ok: true, cancelled: true });
    }
    return baseFetch(url, options);
  };
  const provider = new KubernetesSandboxProvider({
    apiClient: api,
    namespace: 'partners-sandbox',
    allowedRegistries: ['registry.example'],
    agentSecret: 'cancel'.repeat(6),
    fetchImpl: fetch,
  });
  const events = [];
  const running = provider.runJob({
    id: 'job_init_cancel',
    executionMode: ExecutionMode.EphemeralInterpreter,
    sandbox: {
      image: `registry.example/partners/tools@sha256:${'3'.repeat(64)}`,
      init: { argv: ['/workspace/wait.sh'], timeoutSeconds: 30 },
    },
    command: { argv: ['true'] },
    timeoutSeconds: 30,
  }, (event) => events.push(event));

  await started;
  await provider.cancel('job_init_cancel', 'test init cancellation');
  const result = await running;
  assert.equal(result.state, 'cancelled');
  assert.ok(events.some((event) => event.type === 'sandbox.init.failed'));
  assert.equal(api.pods.size, 0);
  assert.equal(api.services.size, 0);
});

test('cleans up a Pod when the image cannot reach Ready', async () => {
  const api = new FailingPodApi();
  const provider = new KubernetesSandboxProvider({
    apiClient: api,
    namespace: 'partners-sandbox',
    startupTimeoutSeconds: 0.01,
    allowedRegistries: ['registry.example'],
    agentSecret: 'pullfail'.repeat(4),
    fetchImpl: createFakeAgentFetch(),
  });
  const result = await provider.runJob({
    id: 'job_pull_failure',
    executionMode: ExecutionMode.EphemeralInterpreter,
    sandbox: {
      image: `registry.example/partners/missing@sha256:${'4'.repeat(64)}`,
    },
    command: { argv: ['true'] },
    timeoutSeconds: 5,
  });

  assert.equal(result.state, 'failed');
  assert.match(result.stderr, /entered Failed/);
  assert.equal(api.pods.size, 0);
  assert.equal(api.services.size, 0);
});

class FakeApi {
  constructor() {
    this.pods = new Map();
    this.services = new Map();
    this.claims = new Map();
    this.createdPods = [];
  }

  async createPod(namespace, pod) {
    this.createdPods.push(pod);
    this.pods.set(`${namespace}/${pod.metadata.name}`, {
      ...pod,
      status: {
        phase: 'Running',
        conditions: [{ type: 'Ready', status: 'True' }],
      },
    });
  }

  async getPod(namespace, name) {
    const pod = this.pods.get(`${namespace}/${name}`);
    if (!pod) throw Object.assign(new Error('not found'), { statusCode: 404 });
    return pod;
  }

  async patchPod(namespace, name, patch) {
    const pod = await this.getPod(namespace, name);
    pod.metadata = {
      ...pod.metadata,
      annotations: {
        ...(pod.metadata?.annotations ?? {}),
        ...(patch.metadata?.annotations ?? {}),
      },
    };
    return pod;
  }

  async listPods(namespace) {
    return { items: [...this.pods.entries()].filter(([key]) => key.startsWith(`${namespace}/`)).map(([, pod]) => pod) };
  }

  async deletePod(namespace, name) {
    this.pods.delete(`${namespace}/${name}`);
  }

  async createService(namespace, service) {
    this.services.set(`${namespace}/${service.metadata.name}`, service);
  }

  async listServices(namespace) {
    return { items: [...this.services.entries()].filter(([key]) => key.startsWith(`${namespace}/`)).map(([, service]) => service) };
  }

  async deleteService(namespace, name) {
    this.services.delete(`${namespace}/${name}`);
  }

  async createPersistentVolumeClaim(namespace, claim) {
    this.claims.set(`${namespace}/${claim.metadata.name}`, claim);
  }

  async getPersistentVolumeClaim(namespace, name) {
    const claim = this.claims.get(`${namespace}/${name}`);
    if (!claim) throw Object.assign(new Error('not found'), { statusCode: 404 });
    return claim;
  }

  async patchPersistentVolumeClaim(namespace, name, patch) {
    const claim = await this.getPersistentVolumeClaim(namespace, name);
    claim.metadata = {
      ...claim.metadata,
      annotations: {
        ...(claim.metadata?.annotations ?? {}),
        ...(patch.metadata?.annotations ?? {}),
      },
    };
    return claim;
  }

  async deletePersistentVolumeClaim(namespace, name) {
    this.claims.delete(`${namespace}/${name}`);
  }

  async getPodLogs() {
    return '';
  }
}

class FailingPodApi extends FakeApi {
  async createPod(namespace, pod) {
    this.createdPods.push(pod);
    this.pods.set(`${namespace}/${pod.metadata.name}`, {
      ...pod,
      status: { phase: 'Failed', conditions: [] },
    });
  }
}

function createFakeAgentFetch() {
  const files = new Map();
  return async (url, options = {}) => {
    const parsed = new URL(url);
    const body = options.body ? JSON.parse(options.body) : {};
    const key = parsed.hostname;
    if (parsed.pathname === '/health') {
      return response({ ok: true });
    }
    if (parsed.pathname === '/v1/files/write') {
      files.set(`${key}:${body.path}`, body.contentBase64 ?? Buffer.from(body.content ?? '').toString('base64'));
      return response({ ok: true, path: body.path });
    }
    if (parsed.pathname === '/v1/files/read') {
      const contentBase64 = files.get(`${key}:${parsed.searchParams.get('path')}`);
      return contentBase64
        ? response({ ok: true, contentBase64, sizeBytes: Buffer.byteLength(Buffer.from(contentBase64, 'base64')) })
        : response({ ok: false, status: 404, error: 'file not found' });
    }
    if (parsed.pathname === '/v1/exec') {
      const argv = body.argv ?? [];
      const output = argv.at(-1) === 'cat persist.txt' ? 'yes\n' : 'ok\n';
      return response({ ok: true, id: 'exec_test', exitCode: 0, stdout: output, stderr: '' });
    }
    if (parsed.pathname === '/v1/cancel') {
      return response({ ok: true, cancelled: true });
    }
    return response({ ok: false, status: 404, error: 'not found' });
  };
}

function response(body) {
  const status = body.status ?? (body.ok ? 200 : 400);
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(body); },
  };
}

function sandboxResource(kind, name, sandboxKind, { phase, expiresAt } = {}) {
  return {
    apiVersion: 'v1',
    kind,
    metadata: {
      name,
      labels: { app: 'partners-sandbox', 'partners.dev/kind': sandboxKind },
      annotations: expiresAt ? { 'partners.dev/expires-at': expiresAt } : {},
    },
    ...(phase ? { status: { phase } } : {}),
  };
}
