# Kubernetes Runtime and Image Distribution Runbook

This runbook is for the Kubernetes-native Partners provider. It complements
the [provider design](kubernetes-sandbox-provider.md) and the
[gateway release flow](gateway-release.md).

## Runtime policy

The provider uses the node's ordinary container runtime when
`PARTNERS_K8S_RUNTIME_CLASS` is empty. This is the compatibility baseline.
Select an alternate runtime explicitly in the gateway ConfigMap:

```yaml
data:
  PARTNERS_K8S_RUNTIME_CLASS: gvisor
```

`gvisor` must be a registered RuntimeClass whose handler is `runsc` and whose
scheduling selector targets only nodes labelled `partners.dev/gvisor=true`.
Kata can be used with the same mechanism after its RuntimeClass and node
capacity have been qualified. Never change the cluster default RuntimeClass to
make Partners work: the choice belongs to the sandbox Pod.

Every sandbox remains non-privileged, uses the restricted Pod Security profile,
drops all Linux capabilities, disables privilege escalation, and does not mount
the host or the Kubernetes API token. The sandbox Service is ClusterIP-only;
NetworkPolicy admits port 8081 only from the gateway namespace and allows DNS
egress only.

## Image distribution

Use the organization Registry as the source of truth. Push both immutable
gateway and sandbox-agent tags, record their digests, and grant pull access via
a namespace-local `imagePullSecret`. For a different build and node
architecture, make the target explicit:

```bash
DOCKER_PLATFORM=linux/amd64 \
IMAGE_REPOSITORY=ghcr.io/limmytian/partners-gateway \
SANDBOX_IMAGE_REPOSITORY=ghcr.io/limmytian/partners-sandbox \
IMAGE_TAG=<immutable-tag> \
  bash scripts/gateway-release.sh build
IMAGE_TAG=<immutable-tag> bash scripts/gateway-release.sh push
```

If mainland network conditions prevent a node pull, use one of these approved
paths, in order: the reachable organization Registry, a controlled Registry
proxy, or a pre-pull on every eligible node. Do not add public mirror URLs or
credentials to a manifest, image, Task Weaver comment, or repository.

The sandbox image must contain `node` and the tools promised by the workload
contract (`bash`, `git`, and `python3` in the current release image). Verify
the image architecture and tools before rollout:

```bash
docker image inspect <image> --format '{{.Architecture}}'
docker run --rm <image> sh -lc 'command -v node; command -v bash; command -v git; command -v python3'
```

### Custom sandbox profiles and bootstrap

Custom session/job images are opt-in through the `sandbox` request object. A
custom image must use an organization-allowlisted registry and an immutable
`@sha256:<64-hex-digest>` reference. Configure the allowlist and optional
profile map in the gateway environment; profile JSON is platform configuration,
not a client-provided credential:

```dotenv
GATEWAY_PROVIDER=kubernetes
PARTNERS_K8S_ALLOWED_REGISTRIES=ghcr.io/limmytian
PARTNERS_K8S_ALLOWED_PROFILES=python-tools
PARTNERS_K8S_SANDBOX_PROFILES={"python-tools":{"image":"ghcr.io/limmytian/partners/python-tools@sha256:<digest>","imagePullSecretRef":"platform://registry/partners","imagePullPolicy":"IfNotPresent","architecture":"amd64"}}
```

Clients may send `profile`, or an explicitly authorized immutable `image`,
`imagePullSecretRef`, `imagePullPolicy`, `architecture`, and `init` block. The
pull-secret value, registry JSON, bearer token, password, and private key are
never accepted in a request. The platform resolver maps the reference to a
namespace-local Kubernetes Secret name. Initialization runs after `/health`
and before the user's command; files stay under `/workspace`, non-zero exit,
timeout, or cancellation fails the job, and a successful session init hash is
persisted on both the Pod and PVC for restart reuse.

## Deploy and verify

1. Inject `POSTGRES_URL`, `GATEWAY_SERVICE_TOKEN`, S3 credentials, and a random
   `PARTNERS_K8S_AGENT_SECRET` through the cluster secret manager. Keep values
   out of Git and shell history where possible.
2. Deploy the checked-in non-Secret manifest through the repository script and
   wait for rollout. Use the paired digests archived by Jenkins:

   ```bash
   K8S_CONTEXT=<context> IMAGE_TAG=<immutable-tag> \
   GATEWAY_IMAGE_DIGEST=sha256:<gateway-digest> \
   SANDBOX_IMAGE_DIGEST=sha256:<sandbox-digest> \
     bash scripts/gateway-release.sh deploy
   ```

3. Confirm the gateway Pod, RuntimeClass, and dependencies:

   ```bash
   kubectl -n partners rollout status deployment/partners-gateway
   kubectl -n partners get pods -l app=partners-gateway -o wide
   kubectl -n partners get configmap partners-gateway-config \
     -o jsonpath='{.data.PARTNERS_K8S_RUNTIME_CLASS}{"\\n"}'
   kubectl get runtimeclass gvisor -o jsonpath='{.handler}{"\\n"}'
   kubectl -n partners get resourcequota,networkpolicy
   ```

4. Run the gateway smoke with live dependency checks and S3 artifact
   assertions. Check `/health`, `/ready`, `/metrics`, auth bounds, SSE replay,
   artifact download, cancellation, and restart durability.
5. Create a PVC-backed session and verify the PVC is `Bound` with the intended
   storage class (for staging this is the project-scoped
   `partners-juicefs-rustfs`). Confirm that a file
   survives a gateway restart before deleting the session.
6. For a custom-image candidate, record the image digest and run an ephemeral
   job plus a PVC session with init success, non-zero failure, timeout,
   cancellation, Pod recreation, and an intentionally bad image pull. Confirm
   `sandbox.init.*` events contain only the hash/version and that errors contain
   neither command output nor credential material.

## Diagnostics

| Symptom | Check | Action |
| --- | --- | --- |
| `no match for platform in manifest` | `kubectl get node -o jsonpath='{.status.nodeInfo.architecture}'` and image architecture | Rebuild/push with `DOCKER_PLATFORM` matching the node. |
| `ImagePullBackOff` | Pod events and `imagePullSecrets` in both namespaces | Verify Registry reachability, digest/tag, and the namespace-local pull secret. |
| sandbox Pod Ready but first request says `fetch failed` | Service endpoints and sandbox `/health` | The provider has a bounded agent health wait; inspect DNS/NetworkPolicy and retry after rollout. |
| PVC Pending | PVC events, CSI provisioner, storage class | Check `csi.juicefs.com`, JuiceFS mount health, quota, and requested capacity. |
| `/ready` is `starting` | `storeHealth` and `artifactStoreHealth` in `/ready` | Test Postgres/S3 endpoint reachability without printing credentials. |
| sandbox cannot be reached from another namespace | `kubectl get networkpolicy -n partners-sandbox` | This is expected; only the gateway namespace is allowed to call the agent. |

Capture Pod events, image digests, and redacted job SSE events. Never capture
service tokens, Registry passwords, kubeconfigs, or raw S3 credentials.

## Rollback and runtime fallback

Rollback the gateway Deployment to the previous ReplicaSet and wait for Ready:

```bash
K8S_CONTEXT=<context> bash scripts/gateway-release.sh rollback
```

If the runtime itself is the suspect, set
`PARTNERS_K8S_RUNTIME_CLASS` to an empty value, roll the gateway, and run the
ordinary-runtime smoke. Restore `gvisor` only after confirming the gVisor
RuntimeClass and node selector are healthy. Do not delete a PVC while
investigating a session; first preserve job events and verify the file through
the recovered session.

## Production admission checklist

- [ ] Gateway and sandbox digests are recorded and pullable on every eligible
      architecture.
- [ ] Registry pull credentials are namespace-scoped and rotatable.
- [ ] RuntimeClass handler, node selector, and ordinary-runtime fallback were
      exercised.
- [ ] Restricted Pod Security, RBAC, NetworkPolicy, and ResourceQuota checks
      pass from a clean cluster context.
- [ ] Ephemeral/session smoke passes, including artifacts, cancellation,
      timeout, and cleanup.
- [ ] Custom profile/image smoke passes for both ephemeral and PVC sessions:
      digest/allowlist/pull-secret rejection, init success/failure/timeout/
      cancellation, Pod recreation, and no secret leakage.
- [ ] PVC/CSI isolation and read-after-restart durability are proven for the
      target JuiceFS class.
- [ ] The Partners-scoped JuiceFS class uses `Delete` reclaim policy; do not
      use the shared `juicefs-rustfs` Retain class for disposable validation
      sessions.
- [ ] Gateway `/ready` and `/metrics` are scraped and alerting is configured.
- [ ] A documented rollout undo has been executed successfully.
- [ ] Node-loss/restart, capacity/performance, and long-term JuiceFS tests are
      complete; otherwise the release remains staging-only.
