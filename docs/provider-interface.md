# AgentExecutionProvider Interface

Status: implemented contract

Reviewed on: 2026-08-13

## Goal

Hide runtime-specific details behind one provider boundary. The gateway translates public API requests into provider calls, while each provider handles sandbox/session creation, command execution, file transfer, teardown, and provider-specific lifecycle details.

## Contract

```ts
interface AgentExecutionProvider {
  readonly name: string

  createSession(request: CreateSessionRequest): Promise<ExecutionSession>
  getSession(sessionId: string): Promise<ExecutionSession | null>
  deleteSession(sessionId: string): Promise<ExecutionSession>

  runJob(
    request: ExecutionJobRequest,
    onEvent?: (event: ExecutionEvent) => void
  ): Promise<ExecutionJobResult>

  cancel(jobId: string, reason?: string): Promise<void>
}
```

## Required Capabilities

| Capability | Required behavior |
| --- | --- |
| Execution modes | Support `ephemeral_interpreter` and `workspace_session`. |
| File transfer | Write input files before execution and copy declared artifacts out before teardown. |
| Git | Clone requested repositories with scoped credential references. |
| Secrets | Accept secret refs or short-lived inline secrets without returning them in results. |
| Network policy | Accept outbound mode, allowlist hosts, and preview ports even when provider support is partial. |
| Resources | Accept CPU, memory, disk, timeout, and snapshot inputs. |
| Logging | Stream stdout, stderr, lifecycle, artifact, and final events. |
| Cancellation | Abort an active job when supported and mark result as cancelled or timed out. |
| Teardown | Destroy ephemeral sandboxes after artifacts are exported. |

## Prototype Implementations

### LocalSandboxProvider

`LocalSandboxProvider` runs commands in isolated temporary directories on the local host. It is not a security boundary; it exists to validate gateway orchestration and tests without external runtime infrastructure.

It supports:

- ephemeral temp workspaces with cleanup
- persistent workspace sessions
- input file injection
- command execution with timeout and cancellation
- stdout/stderr event streaming
- artifact copy-out

### KubernetesSandboxProvider

`KubernetesSandboxProvider` is the self-hosted runtime implementation. Each sandbox is a non-privileged Pod with a private ClusterIP Service; the gateway uses the in-Pod `sandbox-agent` HTTP API for file and process operations.

It maps:

- ephemeral jobs to Pod/Service creation, execution, artifact export, and cleanup
- workspace sessions to reusable Pods backed by `emptyDir` or an optional PVC
- input files, repository checkout, command execution, cancellation, and declared artifacts to authenticated sandbox-agent operations
- request resources, deadlines, RuntimeClass, and storage policy to Kubernetes objects
- gateway startup reconciliation to expired job cleanup and retained-PVC session recovery

### CubeSandboxProvider

`CubeSandboxProvider` is the dedicated hardware-virtualized MicroVM provider. It delegates execution, storage, and snapshots to a CubeSandbox daemon service or runs local MicroVM simulation.

It maps:

- sub-60ms cold start microVM sessions with hardware KVM isolation and independent kernels
- remote command execution with live stdout/stderr event streaming and cooperative cancellation
- workspace directory tree inspection, file preview, and bidirectional tar.gz archive synchronization
- millisecond-level CubeCoW memory/filesystem snapshots and instant branch forks (`createSnapshot`, `forkFromSnapshot`)
- interactive terminal sessions over WebSocket PTY channels

## Runtime Notes

The gateway uses `LocalSandboxProvider` for unit tests and local control-plane development. Staging and production-shaped self-hosting use `KubernetesSandboxProvider` or `CubeSandboxProvider` depending on whether container Pods or dedicated MicroVMs are required.

Runtime configuration and operational constraints are documented in [kubernetes-sandbox-provider.md](kubernetes-sandbox-provider.md) and [kubernetes-runtime-runbook.md](kubernetes-runtime-runbook.md).
