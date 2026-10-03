import {
  ExecutionMode,
  JobState,
  normalizeSandboxConfiguration,
} from '../core/provider-contract.js';
import { parseGitRemoteUrl, redactGitCredentialMaterial } from '../security/git-credentials.js';

export const TaskWeaverExecutionSource = Object.freeze({
  WebChat: 'web_chat',
  Scheduler: 'scheduler',
});

export const TaskWeaverGatewayScope = Object.freeze({
  JobsCreate: 'jobs:create',
  JobsRead: 'jobs:read',
  JobsCancel: 'jobs:cancel',
  ArtifactsRead: 'artifacts:read',
});

export const DefaultTaskWeaverGatewayScopes = Object.freeze([
  TaskWeaverGatewayScope.JobsCreate,
  TaskWeaverGatewayScope.JobsRead,
  TaskWeaverGatewayScope.ArtifactsRead,
]);

export function buildTaskWeaverSandboxJobRequest(request = {}) {
  const taskWeaver = normalizeTaskWeaverContext(request.taskWeaver);
  const executionMode = request.executionMode ?? (request.sessionId
    ? ExecutionMode.WorkspaceSession
    : ExecutionMode.EphemeralInterpreter);

  const credentialRefs = [...new Set([
    ...(request.credentialRefs ?? []),
    ...(request.gitCredentialGrants ?? []).map((grant) => grant.id).filter(Boolean),
  ])];
  const repositoryCredentialRef = request.repository?.credentialRef ?? credentialRefs[0];
  const sandbox = request.sandbox === undefined
    ? undefined
    : normalizeSandboxConfiguration(request.sandbox);

  return {
    id: request.id,
    executionMode,
    tenantId: request.tenantId ?? `tw:${taskWeaver.projectId}`,
    projectId: taskWeaver.projectId,
    sessionId: request.sessionId,
    provider: request.provider ?? 'auto',
    snapshot: request.snapshot,
    sandbox,
    repository: request.repository
      ? {
          ...request.repository,
          credentialRef: repositoryCredentialRef,
        }
      : undefined,
    command: request.command ?? defaultTaskWeaverCommand(request),
    code: request.code,
    inputs: {
      files: [
        buildTaskWeaverContextFile({ ...request, taskWeaver }),
        ...(request.inputs?.files ?? []),
      ],
    },
    resources: request.resources,
    timeoutSeconds: request.timeoutSeconds ?? 1800,
    network: normalizeNetworkPolicy(request),
    credentialRefs,
    artifactPolicy: request.artifactPolicy ?? defaultTaskWeaverArtifactPolicy(request),
    metadata: redactGitCredentialMaterial({
      ...(request.metadata ?? {}),
      taskWeaver,
      integration: 'task-weaver-server-side-agent',
    }),
  };
}

export function buildTaskWeaverGatewayRequestEnvelope({
  jobRequest,
  serviceTokenRef,
  idempotencyKey,
  actor,
  scopes = DefaultTaskWeaverGatewayScopes,
} = {}) {
  if (!jobRequest?.executionMode) {
    throw new TypeError('Gateway request envelope requires a jobRequest');
  }
  if (!serviceTokenRef) {
    throw new TypeError('Gateway request envelope requires serviceTokenRef');
  }

  return {
    method: 'POST',
    path: '/v1/jobs',
    headers: {
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      ...(actor?.id ? { 'X-Actor-Id': actor.id } : {}),
      ...(actor?.type ? { 'X-Actor-Type': actor.type } : {}),
    },
    requiredScopes: [...scopes],
    secretRefs: [serviceTokenRef],
    body: jobRequest,
  };
}

export async function runTaskWeaverAgentThroughGateway({
  gateway,
  resultSink,
  request,
  onUpdate = () => {},
} = {}) {
  if (!gateway?.runJob && !gateway?.createJob) {
    throw new TypeError('Task Weaver bridge requires a gateway with runJob or createJob');
  }

  const jobRequest = buildTaskWeaverSandboxJobRequest(request);
  const updates = [];
  const handleEvent = (event) => {
    const update = mapGatewayEventToTaskWeaverUpdate(event, jobRequest.metadata.taskWeaver);
    updates.push(update);
    resultSink?.recordEvent?.(update);
    onUpdate(update);
  };

  if (gateway.runJob) {
    const jobResult = await gateway.runJob(jobRequest, handleEvent);
    const resultPatch = buildTaskWeaverResultPatch({
      jobResult,
      taskWeaver: jobRequest.metadata.taskWeaver,
    });
    resultSink?.persistResult?.(resultPatch);
    return { jobRequest, jobResult, updates, resultPatch };
  }

  const acceptedJob = await gateway.createJob(jobRequest);
  const update = mapGatewayEventToTaskWeaverUpdate({
    type: 'job.state',
    state: acceptedJob.state ?? JobState.Queued,
    jobId: acceptedJob.id,
    sequence: 0,
    at: new Date().toISOString(),
  }, jobRequest.metadata.taskWeaver);
  updates.push(update);
  resultSink?.recordEvent?.(update);
  onUpdate(update);
  return { jobRequest, acceptedJob, updates, resultPatch: null };
}

export function mapGatewayEventToTaskWeaverUpdate(event = {}, taskWeaver = {}) {
  const base = {
    taskId: taskWeaver.taskId ?? null,
    requirementId: taskWeaver.requirementId ?? null,
    projectId: taskWeaver.projectId ?? null,
    sequence: event.sequence ?? null,
    at: event.at ?? new Date().toISOString(),
    gatewayJobId: event.jobId ?? null,
  };

  if (event.type === 'job.state') {
    return {
      ...base,
      type: 'execution_status',
      status: event.state,
    };
  }
  if (event.type === 'log.stdout' || event.type === 'log.stderr') {
    return {
      ...base,
      type: 'execution_log',
      stream: event.type === 'log.stdout' ? 'stdout' : 'stderr',
      content: event.chunk ?? '',
    };
  }
  if (event.type === 'artifact.created') {
    return {
      ...base,
      type: 'artifact_created',
      artifact: redactGitCredentialMaterial(event.artifact),
    };
  }
  if (event.type === 'job.final') {
    return {
      ...base,
      type: 'execution_final',
      status: event.state,
      exitCode: event.exitCode ?? null,
      artifactCount: event.artifactCount ?? 0,
    };
  }

  return {
    ...base,
    type: 'execution_event',
    eventType: event.type ?? 'unknown',
    payload: redactGitCredentialMaterial(event),
  };
}

export function buildTaskWeaverResultPatch({ jobResult, taskWeaver = {} } = {}) {
  if (!jobResult?.id) {
    throw new TypeError('Task Weaver result patch requires a jobResult');
  }

  const terminalState = jobResult.state;
  const artifactSummaries = (jobResult.artifacts ?? []).map((artifact) => redactGitCredentialMaterial({
    id: artifact.id,
    kind: artifact.kind,
    name: artifact.name,
    sizeBytes: artifact.sizeBytes ?? null,
    storageUri: artifact.storageUri,
    createdAt: artifact.createdAt,
  }));

  return {
    taskId: taskWeaver.taskId ?? null,
    requirementId: taskWeaver.requirementId ?? null,
    projectId: taskWeaver.projectId ?? null,
    taskStatus: 'in_review',
    reviewRequired: true,
    summary: summarizeJobResult(jobResult),
    comment: buildReviewComment(jobResult, artifactSummaries),
    metadata: redactGitCredentialMaterial({
      gatewayJobId: jobResult.id,
      provider: jobResult.provider,
      providerJobId: jobResult.providerJobId ?? null,
      terminalState,
      exitCode: jobResult.exitCode ?? null,
      artifactCount: artifactSummaries.length,
      completedAt: jobResult.completedAt ?? null,
    }),
    artifacts: artifactSummaries,
  };
}

export function buildTaskWeaverContextFile(request = {}) {
  const content = {
    taskWeaver: request.taskWeaver,
    prompt: request.prompt ?? '',
    instructions: request.instructions ?? null,
    repository: request.repository ? redactGitCredentialMaterial(request.repository) : null,
  };

  return {
    path: '/workspace/.task-weaver/context.json',
    contentBase64: Buffer.from(`${JSON.stringify(content, null, 2)}\n`).toString('base64'),
  };
}

function normalizeTaskWeaverContext(context = {}) {
  if (!context.projectId) {
    throw new TypeError('Task Weaver context requires projectId');
  }
  if (!context.taskId && !context.conversationId && !context.schedulerRunId) {
    throw new TypeError('Task Weaver context requires taskId, conversationId, or schedulerRunId');
  }
  if (context.source && !Object.values(TaskWeaverExecutionSource).includes(context.source)) {
    throw new TypeError(`Unsupported Task Weaver execution source: ${context.source}`);
  }

  return {
    projectId: context.projectId,
    requirementId: context.requirementId ?? null,
    taskId: context.taskId ?? null,
    conversationId: context.conversationId ?? null,
    schedulerRunId: context.schedulerRunId ?? null,
    source: context.source ?? TaskWeaverExecutionSource.WebChat,
    actor: context.actor ?? { type: 'agent', id: 'pi' },
  };
}

function defaultTaskWeaverCommand(request) {
  if (request.code) {
    return undefined;
  }

  return {
    argv: ['pi-agent', 'run', '--context', '/workspace/.task-weaver/context.json'],
    cwd: request.repository ? '/workspace/repo' : '/workspace',
  };
}

function normalizeNetworkPolicy(request) {
  const repositoryHost = request.repository?.url ? parseGitRemoteUrl(request.repository.url).host : null;
  const allowedHosts = [
    ...(request.network?.allowedHosts ?? []),
    ...(repositoryHost ? [repositoryHost] : []),
  ];

  return {
    outbound: request.network?.outbound ?? 'allowlist',
    allowedHosts: [...new Set(allowedHosts)],
    previewPorts: request.network?.previewPorts ?? [],
  };
}

function defaultTaskWeaverArtifactPolicy(request) {
  const collect = [
    'stdout',
    'stderr',
    'workspace:/workspace/.partners',
  ];
  if (request.repository || request.sessionId) {
    collect.push('workspace:/workspace/repo/.partners');
    collect.push('workspace:/workspace/repo/test-results');
  }
  return { collect };
}

function summarizeJobResult(jobResult) {
  const exit = jobResult.exitCode === null || jobResult.exitCode === undefined
    ? 'no exit code'
    : `exit code ${jobResult.exitCode}`;
  return `Sandbox job ${jobResult.id} ${jobResult.state} with ${exit}.`;
}

function buildReviewComment(jobResult, artifacts) {
  const lines = [
    summarizeJobResult(jobResult),
    `Provider: ${jobResult.provider ?? 'unknown'}`,
    `Artifacts: ${artifacts.length}`,
  ];
  if (jobResult.state !== JobState.Succeeded) {
    lines.push('Human review is required before retrying or marking the task done.');
  } else {
    lines.push('Human review is required before marking the task done.');
  }
  return lines.join('\n');
}
