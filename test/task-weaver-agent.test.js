import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  GitCredentialProvider,
  GitOperation,
  LocalSandboxProvider,
  TaskWeaverExecutionSource,
  TaskWeaverGatewayScope,
  buildTaskWeaverGatewayRequestEnvelope,
  buildTaskWeaverSandboxJobRequest,
  buildTaskWeaverContextFile,
  createScopedGitCredentialGrant,
  runTaskWeaverAgentThroughGateway,
} from '../src/index.js';

const taskWeaver = {
  projectId: 'tw_project_1',
  requirementId: 'tw_req_1',
  taskId: 'tw_task_1',
  source: TaskWeaverExecutionSource.WebChat,
  actor: { type: 'human', id: 'user_1' },
};

test('builds a gateway job request from Task Weaver context', () => {
  const grant = createScopedGitCredentialGrant({
    id: 'gitcred_1',
    provider: GitCredentialProvider.GitHubApp,
    repository: { host: 'github.com', owner: 'example', name: 'repo' },
    operations: [GitOperation.Clone, GitOperation.PushBranch],
    expiresAt: '2026-07-05T07:00:00.000Z',
    tokenRef: 'secret://vault/gitcred_1',
  });

  const request = buildTaskWeaverSandboxJobRequest({
    taskWeaver,
    repository: { url: 'https://github.com/example/repo.git', branch: 'main' },
    gitCredentialGrants: [grant],
    prompt: 'Run tests and summarize the result.',
    network: { allowedHosts: ['registry.npmjs.org'] },
  });

  assert.equal(request.executionMode, 'ephemeral_interpreter');
  assert.equal(request.tenantId, 'tw:tw_project_1');
  assert.equal(request.repository.credentialRef, 'gitcred_1');
  assert.deepEqual(request.credentialRefs, ['gitcred_1']);
  assert.ok(request.network.allowedHosts.includes('github.com'));
  assert.ok(request.network.allowedHosts.includes('registry.npmjs.org'));
  assert.equal(request.inputs.files[0].path, '/workspace/.task-weaver/context.json');

  const context = JSON.parse(Buffer.from(request.inputs.files[0].contentBase64, 'base64').toString('utf8'));
  assert.equal(context.taskWeaver.taskId, 'tw_task_1');
  assert.equal(context.prompt, 'Run tests and summarize the result.');
});

test('carries the provider-neutral sandbox profile without raw secret material', () => {
  const request = buildTaskWeaverSandboxJobRequest({
    taskWeaver,
    sandbox: {
      profile: 'node-tools',
      image: `registry.example/partners/node-tools@sha256:${'b'.repeat(64)}`,
      imagePullSecretRef: 'platform://registry/partners',
      init: {
        argv: ['/workspace/bootstrap.sh'],
        env: { NODE_ENV: 'test' },
        timeoutSeconds: 20,
      },
    },
    command: { argv: ['node', '-e', 'console.log(1)'] },
  });

  assert.equal(request.sandbox.profile, 'node-tools');
  assert.equal(request.sandbox.imagePullSecretRef, 'platform://registry/partners');
  assert.equal(request.sandbox.init.timeoutSeconds, 20);
  assert.equal(request.sandbox.init.env.NODE_ENV, 'test');
});

test('rejects raw registry credentials in Task Weaver sandbox configuration', () => {
  assert.throws(() => buildTaskWeaverSandboxJobRequest({
    taskWeaver,
    sandbox: {
      image: `registry.example/partners/tools@sha256:${'c'.repeat(64)}`,
      init: { env: { REGISTRY_TOKEN: 'ghp_should-not-be-sent' } },
    },
    command: { argv: ['node', '-e', 'console.log(1)'] },
  }), /secret references|raw secret/);
});

test('builds a scoped gateway request envelope without raw bearer tokens', () => {
  const jobRequest = buildTaskWeaverSandboxJobRequest({
    taskWeaver,
    command: { argv: [process.execPath, '-e', 'console.log(1)'] },
  });

  const envelope = buildTaskWeaverGatewayRequestEnvelope({
    jobRequest,
    serviceTokenRef: 'secret://tw/gateway-service-token',
    idempotencyKey: 'tw-task-tw_task_1-run-1',
    actor: { type: 'agent', id: 'tw-server-pi' },
    scopes: [
      TaskWeaverGatewayScope.JobsCreate,
      TaskWeaverGatewayScope.JobsRead,
      TaskWeaverGatewayScope.ArtifactsRead,
    ],
  });

  assert.equal(envelope.method, 'POST');
  assert.equal(envelope.path, '/v1/jobs');
  assert.equal(envelope.headers['Idempotency-Key'], 'tw-task-tw_task_1-run-1');
  assert.deepEqual(envelope.secretRefs, ['secret://tw/gateway-service-token']);
  assert.equal(envelope.headers.Authorization, undefined);
});

test('runs a Task Weaver agent job through the local gateway contract', async () => {
  const provider = new LocalSandboxProvider();
  const recordedEvents = [];
  const persistedResults = [];

  const result = await runTaskWeaverAgentThroughGateway({
    gateway: provider,
    resultSink: {
      recordEvent: (event) => recordedEvents.push(event),
      persistResult: (patch) => persistedResults.push(patch),
    },
    request: {
      taskWeaver,
      command: {
        argv: [
          process.execPath,
          '-e',
          "const fs=require('fs'); const ctx=JSON.parse(fs.readFileSync('.task-weaver/context.json','utf8')); fs.mkdirSync('out',{recursive:true}); fs.writeFileSync('out/summary.txt', ctx.taskWeaver.taskId); console.log('task='+ctx.taskWeaver.taskId);",
        ],
        cwd: '/workspace',
      },
      artifactPolicy: {
        collect: ['workspace:/workspace/out/summary.txt'],
      },
      timeoutSeconds: 30,
    },
  });

  assert.equal(result.jobResult.state, 'succeeded');
  assert.ok(recordedEvents.some((event) => event.type === 'execution_log' && event.content.includes('tw_task_1')));
  assert.ok(recordedEvents.some((event) => event.type === 'execution_final'));
  assert.equal(persistedResults.length, 1);
  assert.equal(persistedResults[0].taskStatus, 'in_review');
  assert.equal(persistedResults[0].reviewRequired, true);
  assert.equal(persistedResults[0].artifacts.some((item) => Object.hasOwn(item, 'localPath')), false);

  const artifact = result.jobResult.artifacts.find((item) => item.name === 'summary.txt');
  assert.ok(artifact);
  assert.equal(await readFile(artifact.localPath, 'utf8'), 'tw_task_1');
});

test('encodes Task Weaver context without leaking repository credentials', () => {
  const file = buildTaskWeaverContextFile({
    taskWeaver,
    prompt: 'Do work',
    repository: {
      url: 'https://user:ghp_secret123@github.com/example/repo.git',
      credentialRef: 'gitcred_1',
    },
  });

  const decoded = Buffer.from(file.contentBase64, 'base64').toString('utf8');
  assert.match(decoded, /Do work/);
  assert.doesNotMatch(decoded, /ghp_secret123/);
  assert.match(decoded, /\[REDACTED\]/);
});
