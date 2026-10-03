# Partners JuiceFS Workspace Validation

Date: 2026-08-13

Status: complete for isolated staging validation. The test used no production
data and no credentials were recorded.

Validated gateway image:
`ghcr.io/limmytian/partners-gateway:juicefs-validation-final-20260813-amd64`
at digest
`sha256:abebc7d7e27370eb4f7b272c05183d4365164260cb2b6ca1e9956ecb6ea7c1c2`.

## Storage boundary

The cluster's shared `juicefs-rustfs` StorageClass is backed by
`csi.juicefs.com` and uses a namespace/PVC path pattern, but its reclaim policy
is `Retain`. Deleting a validation PVC therefore leaves a Released PV and
requires a storage-admin cleanup. Partners now declares the project-scoped
`partners-juicefs-rustfs` class in `k8s/k8s-partners-gateway.yaml`:

- same JuiceFS CSI provisioner and secret references in `kube-system`
- same `${.pvc.namespace}-${.pvc.name}` path boundary
- `WaitForFirstConsumer`, expansion enabled
- `Delete` reclaim policy so a deleted session cannot accumulate Released PVs
  in the Partners validation lane

The class name is the default `PARTNERS_K8S_SESSION_STORAGE_CLASS` in the
Partners ConfigMap. Existing shared classes and other namespaces are not
modified.

## Checks

- **Isolation:** two session PVCs were provisioned under distinct names and
  namespace/PVC paths. Session A read `juicefs-A`, session B read only
  `juicefs-B`, and neither sandbox received a Kubernetes ServiceAccount token.
- **Persistence:** after manually deleting session A's Pod, the restarted
  provider found its retained PVC, recreated the Pod/Service, preserved the PVC
  UID, and read `juicefs-A` back. A separate file also survived a gateway
  rollout undo. The provider now discovers a retained PVC when its Pod is
  absent and recreates the session without creating or deleting the claim.
- **Workload smoke:** the live gateway suite passed 71/71, including the
  workspace session, artifact, cancellation, Postgres, and MinIO cases.
- **Performance snapshot:** a 64 MiB sequential write/read measured 103/96
  MiB/s; a 500-file Git init/add/commit took 17.4 seconds; a local 251-file npm
  dependency install took 1.84 seconds and its `npm test` took 1.25 seconds.
  These are staging observations, not production SLOs.
- **Cleanup:** timeout and cancellation remove ephemeral Pod/Service objects;
  deleting a persistent session removes its PVC. With the Partners class the
  associated PV was deleted by CSI rather than left Released. The final
  sandbox namespace contained no Pods, PVCs, or Services.
- **Capacity:** the session request is 3 GiB and the sandbox namespace quota is
  100 Pods, 50 CPU, 100 GiB memory, and 500 GiB ephemeral storage.

## Remaining production gate

This validates the storage contract and cleanup policy on the configured
single-node staging cluster. Production admission still requires multi-node
JuiceFS performance, node-loss/remount, cache freshness, backup/restore, and
long-running Git/dependency workload measurements.
