import { ExecutionMode } from '../core/provider-contract.js';

export const InterpreterProfiles = Object.freeze({
  'python-node-git': {
    snapshot: 'partners-python-node-git',
    resources: { cpu: 1, memoryGiB: 1, diskGiB: 3 },
    timeoutSeconds: 120,
    network: { outbound: 'allowlist', allowedHosts: [] },
  },
  'python-data-lite': {
    snapshot: 'partners-python-data-lite',
    resources: { cpu: 1, memoryGiB: 2, diskGiB: 5 },
    timeoutSeconds: 180,
    network: { outbound: 'allowlist', allowedHosts: [] },
  },
  'node-cli': {
    snapshot: 'partners-node-cli',
    resources: { cpu: 1, memoryGiB: 1, diskGiB: 3 },
    timeoutSeconds: 120,
    network: { outbound: 'allowlist', allowedHosts: [] },
  },
});

export function buildOneShotInterpreterRequest(request) {
  if (!request?.command && !request?.code) {
    throw new TypeError('One-shot interpreter job requires command or code');
  }

  const profileName = request.profile ?? 'python-node-git';
  const profile = InterpreterProfiles[profileName];
  if (!profile) {
    throw new TypeError(`Unknown interpreter profile: ${profileName}`);
  }

  return {
    id: request.id,
    executionMode: ExecutionMode.EphemeralInterpreter,
    provider: request.provider ?? 'auto',
    snapshot: request.snapshot ?? profile.snapshot,
    command: request.command,
    code: request.code,
    inputs: request.inputs ?? {},
    timeoutSeconds: request.timeoutSeconds ?? profile.timeoutSeconds,
    resources: request.resources ?? profile.resources,
    network: request.network ?? profile.network,
    credentialRefs: request.credentialRefs ?? [],
    artifactPolicy: request.artifactPolicy ?? { collect: [] },
    metadata: {
      ...(request.metadata ?? {}),
      profile: profileName,
    },
  };
}

export async function runOneShotInterpreterJob(provider, request, onEvent = () => {}) {
  if (!provider?.runJob) {
    throw new TypeError('A provider with runJob(request, onEvent) is required');
  }

  const providerRequest = buildOneShotInterpreterRequest(request);
  const startedAt = Date.now();
  const result = await provider.runJob(providerRequest, onEvent);
  const runtimeSeconds = Math.max(0.001, (Date.now() - startedAt) / 1000);
  const artifactBytes = result.artifacts?.reduce((sum, artifact) => sum + (artifact.sizeBytes ?? 0), 0) ?? 0;

  return {
    ...result,
    profile: providerRequest.metadata.profile,
    snapshot: providerRequest.snapshot,
    resources: providerRequest.resources,
    timeoutSeconds: providerRequest.timeoutSeconds,
    costEstimate: estimateOneShotCost({
      runtimeSeconds,
      resources: providerRequest.resources,
      artifactBytes,
      rates: request.rates,
    }),
  };
}

export function estimateOneShotCost({ runtimeSeconds, resources = {}, artifactBytes = 0, rates = {} }) {
  const vcpuSecondUsd = rates.vcpuSecondUsd ?? 0;
  const memoryGiBSecondUsd = rates.memoryGiBSecondUsd ?? 0;
  const diskGiBSecondUsd = rates.diskGiBSecondUsd ?? 0;
  const artifactGiBMonthUsd = rates.artifactGiBMonthUsd ?? 0;
  const fixedJobUsd = rates.fixedJobUsd ?? 0;

  const computeUsd = runtimeSeconds
    * ((resources.cpu ?? 0) * vcpuSecondUsd + (resources.memoryGiB ?? 0) * memoryGiBSecondUsd);
  const diskUsd = runtimeSeconds * (resources.diskGiB ?? 0) * diskGiBSecondUsd;
  const artifactGib = artifactBytes / (1024 ** 3);
  const artifactUsd = artifactGib * artifactGiBMonthUsd;
  const totalUsd = computeUsd + diskUsd + artifactUsd + fixedJobUsd;

  return {
    currency: 'USD',
    runtimeSeconds,
    computeUsd,
    diskUsd,
    artifactUsd,
    fixedJobUsd,
    totalUsd,
  };
}
