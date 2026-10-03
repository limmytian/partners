# Provider Comparison Matrix

Reviewed on: 2026-08-13

Goal: compare the Partners Kubernetes-native provider against managed sandboxes and lower-level runtime building blocks.

## Recommendation

Use the in-repo Kubernetes provider as the self-hosted execution path, with
gVisor or Kata selected through `RuntimeClass` for untrusted workloads. Keep
E2B, Modal, Vercel Sandbox, Cloudflare Sandbox, and Fly Machines as
managed-service references; direct Firecracker remains a longer-term
lower-level option.

## Matrix

| Option | Best fit | Self-host/BYOC posture | Storage posture | Strengths | Main concerns | Partners stance |
| --- | --- | --- | --- | --- | --- | --- |
| Partners Kubernetes provider | Self-hosted jobs and workspace sessions | Fully in-cluster; each sandbox is a Pod and private Service | `emptyDir` for ephemeral jobs; optional PVC for sessions; copied artifacts in S3 | Native RBAC, quotas, NetworkPolicy, Pod Security, RuntimeClass; no privileged runner | Must harden streaming, node-loss recovery, egress policy, and staging operations | Current self-hosted provider |
| E2B | Managed code interpreter and app sandboxes | Primarily managed from product docs; open-source components exist | Pause/resume persistence, snapshots, volumes in private beta | Mature agent sandbox API, memory/filesystem persistence | BYOC/self-host posture less direct for our first phase; volume access beta | Reference managed fallback |
| Modal Sandboxes | High-scale managed container sandboxes | Managed platform | Modal Volumes, filesystem/directory snapshots, memory snapshots alpha | Strong scale, custom images, resource controls, GPUs | Less BYOC; storage semantics are Modal-specific; sandbox pricing differs from standard compute | Reference for scale and API design |
| Fly Machines | Low-level VM lifecycle control | Managed Fly platform, low-level API | Local Fly Volumes bound to host/region; one volume per Machine | Simple VM API, regional placement, predictable infra primitive | Not agent-sandbox-native; volumes are local, non-replicated, and one-to-one | Useful fallback runtime, not first provider |
| Cloudflare Sandbox SDK | Edge-adjacent Workers apps executing code | Managed Cloudflare Containers | R2/S3-style persistence patterns; Durable Object coordination | Tight Workers integration, file/command/process APIs, scale-to-zero | Platform-specific to Workers/DO; limits and pricing include Workers/DO/container layers | Reference for external-service API ergonomics |
| Vercel Sandbox | Vercel-native agent/code execution | Managed Vercel | Persistent by default, snapshots, drives beta | Firecracker isolation, SDK/CLI, root/sudo, Node/Python runtimes | Tied to Vercel account/project model; runtime limits; less BYOC | Reference for developer experience |
| Docker + gVisor | Self-operated container isolation | Fully self-hosted | Whatever host/Kubernetes storage provides | OCI/Kubernetes fit, syscall-interposition boundary | Requires node installation, RuntimeClass wiring, and ongoing compatibility checks | Supported isolation option beneath the Kubernetes provider |
| Kata Containers | Self-operated VM-backed containers | Fully self-hosted | Kubernetes/container storage primitives | Stronger isolation than regular containers, OCI/Kubernetes integration | Higher ops complexity; not a full sandbox product | Compatible RuntimeClass option; not yet staged |
| Direct Firecracker | Custom microVM platform | Fully self-hosted | Must build block/rootfs/snapshot/storage layer | Strong isolation, minimal VMM, proven serverless primitive | Largest engineering burden; must build everything above VMM | Long-term option only |

## Evaluation By Requirement

| Requirement | Partners Kubernetes provider | Managed alternatives | Lower-level runtimes |
| --- | --- | --- | --- |
| Ephemeral interpreter jobs | Implemented with disposable Pod/Service sandboxes | Strong on E2B/Modal/Vercel/Cloudflare | Possible but requires orchestration |
| Workspace agent sessions | Implemented with reusable Pods and optional PVCs | Mixed: Vercel/E2B strong, Modal capable | Possible with much more code |
| JuiceFS persistence | Validated through the cluster CSI driver on single-node staging | Generally weak unless the provider supports custom mounts | Strong control, but high build cost |
| Provider-neutral API | Implemented gateway and provider contract | Good reference surfaces | Requires building all abstractions |
| Scoped Git workflows | Gateway-owned credential references and sandbox process primitives | Similar | Fully custom |
| Operational burden | Medium/high | Low | High |
| Vendor lock-in | Low at the provider boundary; Kubernetes/CSI operations remain | Medium/high | Low |

## Cost Posture

Do not optimize for listed per-second rates yet. First optimize for lifecycle semantics:

- one-shot jobs must auto-delete and copy artifacts out
- idle workspaces should stop/archive instead of burning compute
- persistent storage should be separately metered and bounded
- warm snapshots should reduce package-install latency

Public pricing and limits change frequently. The first cost model should be parameterized by:

```text
job_cost =
  sandbox_runtime_seconds * (vcpu_rate * vcpus + memory_rate * gib)
  + persisted_storage_gib_seconds * storage_rate
  + artifact_storage_gib_month * object_storage_rate
  + network_egress_gib * egress_rate
  + provider_fixed_plan_cost / allocated_jobs
```

## Source Notes

- E2B docs, persistence, volumes, billing: https://e2b.dev/docs/
- Modal Sandboxes, Volumes, pricing: https://modal.com/docs/guide/sandboxes and https://modal.com/products/sandboxes
- Fly Machines, Volumes, pricing: https://fly.io/docs/machines/ and https://fly.io/docs/about/pricing/
- Cloudflare Sandbox SDK and Containers pricing: https://developers.cloudflare.com/sandbox/ and https://developers.cloudflare.com/containers/pricing/
- Vercel Sandbox docs: https://vercel.com/docs/sandbox
- gVisor docs: https://gvisor.dev/docs/
- Kata Containers: https://katacontainers.io/
- Firecracker: https://firecracker-microvm.github.io/
