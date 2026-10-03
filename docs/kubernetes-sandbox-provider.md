# Kubernetes-native sandbox provider

Status: staging-validated provider; multi-node production qualification remains open.

Reviewed on: 2026-08-13.

## Why this exists

The initial external-provider experiment did not provide the Kubernetes-native
sandbox primitive required by the self-hosted direction. The Partners provider
in this document uses only the Kubernetes API:

- one non-privileged Pod per sandbox
- one private ClusterIP Service per sandbox
- a small HTTP agent inside the Pod for files and process execution
- optional `RuntimeClass` (gVisor or Kata) for a stronger isolation boundary
- optional PVC-backed workspace sessions
- no Docker socket, host PID/network, Sysbox, or privileged DaemonSet

Kubernetes therefore owns the sandbox lifecycle and resource accounting. The
gateway owns the provider-neutral job/session contract and artifact export.

## Sandbox lifecycle

```text
POST /v1/jobs or POST /v1/sessions
  -> gateway creates Pod + Service in partners-sandbox
  -> Pod becomes Ready
  -> gateway calls the private sandbox-agent API
  -> inputs are written, command runs, artifacts are read back
  -> ephemeral Pod/Service are deleted
```

An ephemeral interpreter job uses `emptyDir` and is deleted after artifact
export. A workspace session remains alive. Set
`PARTNERS_K8S_SESSION_STORAGE_CLASS` or pass `{ persistence: { kind: "pvc" } }`
to make its `/workspace` a PVC instead of `emptyDir`.

Ephemeral Pods also receive `activeDeadlineSeconds`, so a gateway crash cannot
leave unbounded compute running. Gateway startup reconciles expired/terminal
jobs and orphan Services. A periodic janitor is still needed if the gateway can
remain down beyond a job deadline.

## Security defaults

Sandbox Pods run as UID 1000 with `RuntimeDefault` seccomp, drop all Linux
capabilities, disable privilege escalation, and do not receive a Kubernetes
service-account token. The gateway's service account can manage only Pods,
Services, PVCs, and Pod logs in the dedicated `partners-sandbox` namespace.

The included NetworkPolicy allows gateway-to-agent traffic and cluster DNS but
denies other sandbox egress. Add explicit package/Git/model endpoint policies
or an authenticated egress proxy per environment. NetworkPolicy requires a CNI
that enforces it.

The default Kubernetes runtime is still the cluster's ordinary containerd/runc
runtime if no RuntimeClass is configured. The
repository includes an opt-in `gvisor` RuntimeClass in
`k8s/runtimeclass-gvisor.yaml`; it selects only nodes labelled
`partners.dev/gvisor=true`. Install and verify `runsc` on those nodes before
adding the label. Existing workloads are unaffected. For an explicit sandbox
deployment, set `PARTNERS_K8S_RUNTIME_CLASS=gvisor`; leaving the value empty
keeps the normal runtime. The provider does not pretend that an ordinary Pod
is a VM.

The gVisor package must be fetched from the official release endpoint and
verified with its SHA-512 file. In mainland networks, stage that verified
package through the organisation's private artifact/registry path if direct
access is unavailable; do not substitute an unverified mirror (including a
Tsinghua mirror).

### K3s node setup

For K3s, install the official `x86_64` or `aarch64` tarball on every node that
will receive the label. Keep `runsc`, `containerd-shim-runsc-v1`, and the
adjacent `gvisor-bin/` directory together, then add the repository's
`k8s/containerd-gvisor-config-v3.toml.tmpl` to
`/var/lib/rancher/k3s/agent/etc/containerd/`. The v3 template is for the
containerd 2.x bundled by current K3s; older K3s releases use the equivalent
v2 `config.toml.tmpl` path. Restart K3s after changing the template. This
restarts that node's Pods, so do it during a maintenance window and verify
ordinary workloads before enabling the label.

```bash
set -eu
ARCH=x86_64 # use aarch64 on an ARM64 node
BASE=https://storage.googleapis.com/gvisor/releases/release/latest/${ARCH}
install -d /var/lib/gvisor-staging
curl -fsSL "${BASE}/gvisor.tar.bz2" -o /var/lib/gvisor-staging/gvisor.tar.bz2
curl -fsSL "${BASE}/gvisor.tar.bz2.sha512" -o /var/lib/gvisor-staging/gvisor.tar.bz2.sha512
(cd /var/lib/gvisor-staging && sha512sum -c gvisor.tar.bz2.sha512)
tar -xjf /var/lib/gvisor-staging/gvisor.tar.bz2 -C /usr/local/bin
install -m 0644 k8s/containerd-gvisor-config-v3.toml.tmpl \
  /var/lib/rancher/k3s/agent/etc/containerd/config-v3.toml.tmpl
systemctl restart k3s
```

Do not set K3s `--default-runtime` to `runsc`. The named `runsc` handler is
selected only by `runtimeClassName: gvisor`; an empty `runtimeClassName`
continues to use the normal runtime.

Example opt-in rollout after the node runtime is installed:

```bash
kubectl apply -f k8s/runtimeclass-gvisor.yaml
kubectl label node <gvisor-node> partners.dev/gvisor=true --overwrite
kubectl -n partners set env deploy/partners-gateway PARTNERS_K8S_RUNTIME_CLASS=gvisor
kubectl -n partners rollout status deploy/partners-gateway
```

To return to the normal runtime, clear the setting and roll out again:

```bash
kubectl -n partners set env deploy/partners-gateway PARTNERS_K8S_RUNTIME_CLASS-
kubectl -n partners rollout status deploy/partners-gateway
```

## Build and deploy

Build and push both images:

```bash
IMAGE_REPOSITORY=registry.example/partners-gateway \
SANDBOX_IMAGE_REPOSITORY=registry.example/partners-sandbox \
IMAGE_TAG=$(git rev-parse --short HEAD) \
bash scripts/gateway-release.sh build

docker push registry.example/partners-gateway:<tag>
docker push registry.example/partners-sandbox:<tag>
```

Create a random `PARTNERS_K8S_AGENT_SECRET` and provision all required keys in
the external `partners-gateway-secrets` Secret. The checked-in manifest does
not contain a Secret object. Deploy the paired immutable images through the
repository script:

```bash
K8S_CONTEXT=<context> \
IMAGE_REPOSITORY=registry.example/partners-gateway \
SANDBOX_IMAGE_REPOSITORY=registry.example/partners-sandbox \
IMAGE_TAG=<tag> \
GATEWAY_IMAGE_DIGEST=sha256:<gateway-digest> \
SANDBOX_IMAGE_DIGEST=sha256:<sandbox-digest> \
  bash scripts/gateway-release.sh deploy
```

For a persistent workspace session, configure a storage class:

```yaml
PARTNERS_K8S_SESSION_STORAGE_CLASS: "your-block-storage-class"
```

The gateway must be able to resolve `*.partners-sandbox.svc` inside the
cluster. The sandbox namespace is labelled for Kubernetes Pod Security
Standards `restricted`.

## What is deliberately not in v1

- interactive terminal streaming (the agent currently returns command output
  after completion; SSE remains the gateway event interface)
- directory archive download (declared file artifacts are supported first)
- per-request Kubernetes NetworkPolicy objects and egress proxying
- automatic retry/migration of a live workspace after node loss
- a periodic janitor for terminal resources while the gateway is unavailable
- a CRD/operator; the gateway uses ordinary core Kubernetes resources to keep
  the control surface small

These are follow-up capabilities, not reasons to add a privileged runtime.
