# Ephemeral Interpreter Jobs

Status: proof-of-concept lifecycle

Reviewed on: 2026-08-13

## Goal

Support short-lived interpreter-style jobs that create a sandbox from a prepared snapshot, inject files and context, execute code or CLI commands, stream logs, collect artifacts, enforce resource and timeout policy, then destroy the sandbox.

This mode is separate from workspace sessions. It should be optimized for low-latency, bounded, auditable work rather than long-running repository editing.

## Snapshot Profiles

| Profile | Image/profile target | Included tools | Default timeout | Default resources |
| --- | --- | --- | --- | --- |
| `python-node-git` | `partners-python-node-git` | Python, pip, Node, npm, git, curl, jq, unzip, tar | 120s | 1 CPU, 1 GiB RAM, 3 GiB disk |
| `python-data-lite` | `partners-python-data-lite` | Python, pip, common data packages, git, curl | 180s | 1 CPU, 2 GiB RAM, 5 GiB disk |
| `node-cli` | `partners-node-cli` | Node, npm, pnpm, git, curl, jq | 120s | 1 CPU, 1 GiB RAM, 3 GiB disk |

Snapshot build rules:

- Keep base images small and immutable.
- Preinstall slow, common packages; keep user-specific dependencies in inputs or caches.
- Do not bake secrets into snapshots.
- Version snapshots explicitly, then move profile aliases after validation.
- Treat package registry credentials as short-lived credential refs.

## Lifecycle

```text
receive request
  -> select profile and resource tier
  -> create ephemeral provider job request
  -> upload input files
  -> execute command/code
  -> stream stdout/stderr/lifecycle events
  -> copy declared artifacts out
  -> emit terminal summary
  -> remove ephemeral sandbox
```

## Default Policy

| Area | Default |
| --- | --- |
| Execution mode | `ephemeral_interpreter` |
| Network | `allowlist` with no default hosts |
| Timeout | profile default unless caller supplies a lower or explicit value |
| Resources | profile default unless caller supplies a permitted tier |
| Artifacts | stdout/stderr always copied by provider; workspace paths must be declared |
| Persistence | none; exported artifacts are the durable output |

## Cost Model

Rates must come from runtime billing configuration rather than hardcoded source. The helper takes rates as input:

```text
compute = runtime_seconds * (cpu * vcpu_second_rate + memory_gib * memory_gib_second_rate)
disk = runtime_seconds * disk_gib * disk_gib_second_rate
artifacts = artifact_gib_month * artifact_gib_month_rate
total = compute + disk + artifacts + fixed_job_cost
```

The first production dashboard should show:

- requested resources
- actual runtime seconds
- artifact bytes
- estimated provider cost
- timeout and cancellation status

## Prototype

`runOneShotInterpreterJob(provider, request, onEvent)` is implemented in `src/jobs/one-shot-interpreter.js`.

The unit-test path uses `LocalSandboxProvider` to validate orchestration without external infrastructure. The self-hosted runtime uses the same helper with `KubernetesSandboxProvider` and a sandbox image that contains the selected profile's tools.
