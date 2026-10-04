import { randomUUID } from 'node:crypto';
import { ExecutionMode, SessionState } from './provider-contract.js';

/**
 * Standard Sandboxing & MicroVM Capabilities Matrix
 */
export const SandboxCapability = Object.freeze({
  // Base Data-Plane Capabilities (Pod & MicroVM compatible)
  ProcessExec: 'process.exec',
  ProcessStream: 'process.stream',
  ProcessKill: 'process.kill',
  FileRead: 'file.read',
  FileWrite: 'file.write',
  FileList: 'file.list',
  FileStat: 'file.stat',
  FileRemove: 'file.remove',
  ArtifactsPublish: 'artifacts.publish',
  TerminalPty: 'terminal.pty',

  // Advanced Privileged / MicroVM Capabilities (CubeSandbox / MicroVM exclusive)
  MicroVMIsolation: 'microvm.isolation',
  Sub60msColdStart: 'microvm.sub_60ms_start',
  IndependentKernel: 'microvm.independent_kernel',
  MemorySnapshot: 'cube_cow.memory_snapshot',
  InstantFork: 'cube_cow.instant_fork',
  StateRollback: 'cube_cow.state_rollback',
  PciPassThrough: 'microvm.pci_passthrough',
});

/**
 * Provider capability profiles
 */
export const PROVIDER_CAPABILITIES = Object.freeze({
  // Local development provider
  local: Object.freeze([
    SandboxCapability.ProcessExec,
    SandboxCapability.ProcessStream,
    SandboxCapability.ProcessKill,
    SandboxCapability.FileRead,
    SandboxCapability.FileWrite,
    SandboxCapability.FileList,
    SandboxCapability.FileStat,
    SandboxCapability.FileRemove,
    SandboxCapability.ArtifactsPublish,
    SandboxCapability.TerminalPty,
  ]),

  // Kubernetes non-privileged Pod provider
  kubernetes: Object.freeze([
    SandboxCapability.ProcessExec,
    SandboxCapability.ProcessStream,
    SandboxCapability.ProcessKill,
    SandboxCapability.FileRead,
    SandboxCapability.FileWrite,
    SandboxCapability.FileList,
    SandboxCapability.FileStat,
    SandboxCapability.FileRemove,
    SandboxCapability.ArtifactsPublish,
    SandboxCapability.TerminalPty,
  ]),

  // CubeSandbox MicroVM provider (full hardware isolation & CoW snapshots)
  cubesandbox: Object.freeze([
    SandboxCapability.ProcessExec,
    SandboxCapability.ProcessStream,
    SandboxCapability.ProcessKill,
    SandboxCapability.FileRead,
    SandboxCapability.FileWrite,
    SandboxCapability.FileList,
    SandboxCapability.FileStat,
    SandboxCapability.FileRemove,
    SandboxCapability.ArtifactsPublish,
    SandboxCapability.TerminalPty,
    SandboxCapability.MicroVMIsolation,
    SandboxCapability.Sub60msColdStart,
    SandboxCapability.IndependentKernel,
    SandboxCapability.MemorySnapshot,
    SandboxCapability.InstantFork,
    SandboxCapability.StateRollback,
  ]),
});

/**
 * Negotiates capabilities for a provider, validating requested vs supported capabilities.
 *
 * @param {string} providerName - 'local' | 'kubernetes' | 'cubesandbox'
 * @param {string[]} [requestedCapabilities=[]] - Capabilities required by the caller
 * @returns {{ supported: string[], missing: string[], satisfied: boolean, tier: 'basic_pod' | 'microvm_privileged' }}
 */
export function negotiateCapabilities(providerName, requestedCapabilities = []) {
  const supported = PROVIDER_CAPABILITIES[providerName] ?? PROVIDER_CAPABILITIES.local;
  const missing = requestedCapabilities.filter((cap) => !supported.includes(cap));
  const isMicroVm = supported.includes(SandboxCapability.MicroVMIsolation);

  return {
    provider: providerName,
    supported: [...supported],
    missing,
    satisfied: missing.length === 0,
    tier: isMicroVm ? 'microvm_privileged' : 'basic_pod',
  };
}

/**
 * Data-plane contract builder for in-sandbox Artifacts publishing
 */
export function buildArtifactPublishContract({ artifactId, name, path, kind = 'file', retentionClass = 'review', metadata = {} }) {
  if (!name || typeof name !== 'string') {
    throw new TypeError('Artifact publishing requires a non-empty name');
  }
  if (!path || typeof path !== 'string') {
    throw new TypeError('Artifact publishing requires a path');
  }

  return {
    id: artifactId ?? `art_pub_${randomUUID()}`,
    name,
    path,
    kind,
    retentionClass,
    metadata,
    status: 'published',
    publishedAt: new Date().toISOString(),
  };
}

/**
 * E2B Data-Plane Compatibility Layer
 * Adapts E2B SDK calls (filesystem & process operations) to Partners Sandbox Agent endpoints.
 */
export class E2BProtocolAdapter {
  constructor({ client, capabilities = null }) {
    this.client = client; // HTTP client communicating with sandbox agent / gateway
    this.capabilities = capabilities ?? new Set(PROVIDER_CAPABILITIES.local);
  }

  // --- Filesystem Operations ---
  async read(filePath) {
    return this.client.request('/v1/files/read', {
      method: 'GET',
      query: { path: filePath },
    });
  }

  async write(filePath, content) {
    return this.client.request('/v1/files/write', {
      method: 'POST',
      body: {
        path: filePath,
        content: typeof content === 'string' ? content : undefined,
        contentBase64: Buffer.isBuffer(content) ? content.toString('base64') : undefined,
      },
    });
  }

  async list(dirPath = '.') {
    return this.client.request('/v1/files/list', {
      method: 'GET',
      query: { path: dirPath },
    });
  }

  // --- Process Execution Operations ---
  async startProcess(cmd, { cwd = '/workspace', env = {}, timeoutSeconds = 60 } = {}) {
    const argv = Array.isArray(cmd) ? cmd : ['/bin/sh', '-c', cmd];
    return this.client.request('/v1/exec', {
      method: 'POST',
      body: {
        argv,
        cwd,
        env,
        timeoutSeconds,
      },
    });
  }

  // --- Partners Exclusive: In-Sandbox Artifacts Publishing ---
  async publishArtifact(name, filePath, options = {}) {
    const record = buildArtifactPublishContract({
      name,
      path: filePath,
      ...options,
    });
    return this.client.request('/v1/artifacts/publish', {
      method: 'POST',
      body: record,
    });
  }

  // --- MicroVM Capabilities Checks & Operations ---
  supports(capability) {
    return this.capabilities.has ? this.capabilities.has(capability) : this.capabilities.includes(capability);
  }

  async createSnapshot(label) {
    if (!this.supports(SandboxCapability.MemorySnapshot)) {
      throw Object.assign(new Error('MemorySnapshot capability not supported by this provider tier'), { statusCode: 501 });
    }
    return this.client.request('/v1/microvm/snapshot', {
      method: 'POST',
      body: { label },
    });
  }

  async fork(snapshotId) {
    if (!this.supports(SandboxCapability.InstantFork)) {
      throw Object.assign(new Error('InstantFork capability not supported by this provider tier'), { statusCode: 501 });
    }
    return this.client.request('/v1/microvm/fork', {
      method: 'POST',
      body: { snapshotId },
    });
  }
}
