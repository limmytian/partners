# Explicit RuntimeClass and Sandbox Policy Smoke

Date: 2026-08-13

Status: complete for the `Partners 显式运行时 staging smoke` slice. This is
staging evidence; production node-loss and performance qualification remain
follow-up work.

## Runtime selection

The staging gateway was rolled with `PARTNERS_K8S_RUNTIME_CLASS=gvisor` and
the `gvisor` RuntimeClass (`runsc` handler, node selector
`partners.dev/gvisor=true`). A long-running ephemeral job was inspected while
active:

| Check | Result |
| --- | --- |
| Pod phase | `Running` |
| `spec.runtimeClassName` | `gvisor` |
| Node | `ser7` |
| `runAsNonRoot` | `true` |
| `allowPrivilegeEscalation` | `false` |
| capabilities | `drop: [ALL]` |
| cancellation | `cancel_requested` then provider cleanup |
| remaining job Pods/Services | none |

The ConfigMap was then rolled with an empty runtime class. A second long-lived
job ran with `spec.runtimeClassName` absent (the ordinary node runtime), kept
the same non-privileged security context, and was cancelled and cleaned up.
The ConfigMap was restored to `gvisor` and the gateway rollout returned Ready.

## Policy, quota, and RBAC

The applied `partners-sandbox-default` NetworkPolicy has both Ingress and
Egress policy types. Ingress on port 8081 is limited to Pods labelled
`app=partners-gateway` in namespace `partners`; egress is limited to cluster
DNS. A probe Pod in a separate temporary `partners-untrusted` namespace could
resolve the sandbox Service but its `/health` request was blocked, confirming
the default-deny boundary.

The sandbox namespace is labelled with Kubernetes Pod Security `restricted`.
The ResourceQuota is 100 Pods, 50 CPU, 100 GiB memory, and 500 GiB ephemeral
storage. The gateway ServiceAccount can list Pods and create PVCs in
`partners-sandbox` but cannot read Secrets there.

## PVC and failure recovery

The earlier release slice proved a 3 GiB `juicefs-rustfs` PVC can carry a file
across a gateway rollout undo and read it back through the recovered session.
This slice additionally exercised a two-second timeout and a running-job
cancellation; both reached a terminal state and left no job Pod, Service, or
PVC behind. A startup reconcile run also removed an orphan sandbox Service.

All temporary probe namespaces and sessions were deleted after validation.
No credentials or kubeconfig material are stored in this document.
