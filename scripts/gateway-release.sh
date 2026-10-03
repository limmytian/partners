#!/usr/bin/env bash
set -euo pipefail

COMMAND="${1:-help}"
IMAGE_REPOSITORY="${IMAGE_REPOSITORY:-ghcr.io/limmytian/partners-gateway}"
IMAGE_TAG="${IMAGE_TAG:-$(git rev-parse --short HEAD 2>/dev/null || echo local)}"
IMAGE="${IMAGE_REPOSITORY}:${IMAGE_TAG}"
SANDBOX_IMAGE_REPOSITORY="${SANDBOX_IMAGE_REPOSITORY:-${IMAGE_REPOSITORY%/*}/partners-sandbox}"
SANDBOX_IMAGE="${SANDBOX_IMAGE_REPOSITORY}:${IMAGE_TAG}"
GATEWAY_IMAGE_DIGEST="${GATEWAY_IMAGE_DIGEST:-}"
SANDBOX_IMAGE_DIGEST="${SANDBOX_IMAGE_DIGEST:-}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.gateway-smoke.yml}"
K8S_MANIFEST="${K8S_MANIFEST:-k8s/k8s-partners-gateway.yaml}"
K8S_NAMESPACE="${K8S_NAMESPACE:-partners}"
K8S_DEPLOYMENT="${K8S_DEPLOYMENT:-partners-gateway}"
K8S_SERVICE="${K8S_SERVICE:-partners-gateway}"
K8S_CONTEXT="${K8S_CONTEXT:-}"
K8S_SECRET_NAME="${K8S_SECRET_NAME:-partners-gateway-secrets}"
K8S_STORAGE_CLASS="${K8S_STORAGE_CLASS:-partners-juicefs-rustfs}"
K8S_RUNTIME_CLASS="${K8S_RUNTIME_CLASS:-${PARTNERS_K8S_RUNTIME_CLASS:-}}"
K8S_SANDBOX_NAMESPACE="${K8S_SANDBOX_NAMESPACE:-partners-sandbox}"
K8S_SERVICE_ACCOUNT="${K8S_SERVICE_ACCOUNT:-partners-gateway}"
K8S_SANDBOX_ROLE="${K8S_SANDBOX_ROLE:-partners-sandbox-manager}"
K8S_SANDBOX_ROLEBINDING="${K8S_SANDBOX_ROLEBINDING:-partners-sandbox-manager}"
K8S_HEALTH_URL="${K8S_HEALTH_URL:-}"
K8S_HEALTH_PORT="${K8S_HEALTH_PORT:-18080}"
K8S_RUN_SMOKE="${K8S_RUN_SMOKE:-1}"
K8S_SMOKE_PORT="${K8S_SMOKE_PORT:-18081}"
K8S_SMOKE_TIMEOUT_MS="${K8S_SMOKE_TIMEOUT_MS:-120000}"
K8S_SMOKE_RESTART_COMMAND="${K8S_SMOKE_RESTART_COMMAND:-}"
ROLLBACK_GATEWAY_IMAGE_DIGEST="${ROLLBACK_GATEWAY_IMAGE_DIGEST:-}"
DEPLOY_MODE="${DEPLOY_MODE:-production}"
REGISTRY_HOST="${REGISTRY_HOST:-${IMAGE_REPOSITORY%%/*}}"
KUBECTL_CONTEXT_ARGS=()
if [[ -n "$K8S_CONTEXT" ]]; then
  KUBECTL_CONTEXT_ARGS+=(--context "$K8S_CONTEXT")
fi
DOCKER_BUILD_ARGS=()
if [[ -n "${DOCKER_PLATFORM:-}" ]]; then
  DOCKER_BUILD_ARGS+=(--platform "$DOCKER_PLATFORM")
fi

log() { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
die() { printf '[ERROR] %s\n' "$*" >&2; exit 1; }

kubectl_cmd() {
  kubectl "${KUBECTL_CONTEXT_ARGS[@]}" "$@"
}

is_sha256_digest() {
  [[ "$1" =~ ^sha256:[0-9a-f]{64}$ ]]
}

require_immutable_images() {
  [[ "$DEPLOY_MODE" == production ]] || return 0
  [[ "$IMAGE_TAG" != latest ]] || die 'production deployment cannot use IMAGE_TAG=latest'
  is_sha256_digest "$GATEWAY_IMAGE_DIGEST" ||
    die 'production deployment requires GATEWAY_IMAGE_DIGEST=sha256:<64 hex characters>'
  is_sha256_digest "$SANDBOX_IMAGE_DIGEST" ||
    die 'production deployment requires SANDBOX_IMAGE_DIGEST=sha256:<64 hex characters>'
}

gateway_deploy_image() {
  if [[ "$DEPLOY_MODE" == production ]]; then
    printf '%s:%s@%s' "$IMAGE_REPOSITORY" "$IMAGE_TAG" "$GATEWAY_IMAGE_DIGEST"
  else
    printf '%s' "$IMAGE"
  fi
}

sandbox_deploy_image() {
  if [[ "$DEPLOY_MODE" == production ]]; then
    printf '%s:%s@%s' "$SANDBOX_IMAGE_REPOSITORY" "$IMAGE_TAG" "$SANDBOX_IMAGE_DIGEST"
  else
    printf '%s' "$SANDBOX_IMAGE"
  fi
}

require_k8s_context() {
  [[ -n "$K8S_CONTEXT" ]] || die 'K8S_CONTEXT must be set for a Kubernetes operation'
  local context_rows
  context_rows="$(kubectl_cmd config get-contexts "$K8S_CONTEXT" --no-headers 2>/dev/null || true)"
  [[ -n "$context_rows" ]] ||
    die "Kubernetes context not found: $K8S_CONTEXT"
}

require_secret_keys() {
  local key value
  kubectl_cmd -n "$K8S_NAMESPACE" get secret "$K8S_SECRET_NAME" >/dev/null ||
    die "required external Secret not found: $K8S_NAMESPACE/$K8S_SECRET_NAME"
  for key in POSTGRES_URL GATEWAY_SERVICE_TOKEN S3_ACCESS_KEY_ID \
    S3_SECRET_ACCESS_KEY PARTNERS_K8S_AGENT_SECRET; do
    value="$(kubectl_cmd -n "$K8S_NAMESPACE" get secret "$K8S_SECRET_NAME" \
      -o "jsonpath={.data.${key}}" 2>/dev/null || true)"
    [[ -n "$value" ]] || die "external Secret is missing key: $key"
  done
}

read_external_secret() {
  local key encoded
  key="$1"
  encoded="$(kubectl_cmd -n "$K8S_NAMESPACE" get secret "$K8S_SECRET_NAME" \
    -o "jsonpath={.data.${key}}")"
  [[ -n "$encoded" ]] || die "external Secret is missing key: $key"
  printf '%s' "$encoded" |
    node -e 'process.stdout.write(Buffer.from(require("fs").readFileSync(0, "utf8"), "base64").toString())'
}

preflight_k8s() {
  require_immutable_images
  [[ "$IMAGE_REPOSITORY" == "$REGISTRY_HOST/"* ]] ||
    die "gateway image repository is outside REGISTRY_HOST=$REGISTRY_HOST"
  [[ "$SANDBOX_IMAGE_REPOSITORY" == "$REGISTRY_HOST/"* ]] ||
    die "sandbox image repository is outside REGISTRY_HOST=$REGISTRY_HOST"
  require_k8s_context
  kubectl_cmd get namespace "$K8S_NAMESPACE" >/dev/null
  kubectl_cmd get namespace "$K8S_SANDBOX_NAMESPACE" >/dev/null
  require_secret_keys
  kubectl_cmd get storageclass "$K8S_STORAGE_CLASS" >/dev/null ||
    die "required StorageClass not found: $K8S_STORAGE_CLASS"
  kubectl_cmd -n "$K8S_NAMESPACE" get serviceaccount "$K8S_SERVICE_ACCOUNT" >/dev/null ||
    die "required ServiceAccount not found: $K8S_NAMESPACE/$K8S_SERVICE_ACCOUNT"
  kubectl_cmd -n "$K8S_SANDBOX_NAMESPACE" get role "$K8S_SANDBOX_ROLE" >/dev/null ||
    die "required sandbox Role not found: $K8S_SANDBOX_NAMESPACE/$K8S_SANDBOX_ROLE"
  kubectl_cmd -n "$K8S_SANDBOX_NAMESPACE" get rolebinding "$K8S_SANDBOX_ROLEBINDING" >/dev/null ||
    die "required sandbox RoleBinding not found: $K8S_SANDBOX_NAMESPACE/$K8S_SANDBOX_ROLEBINDING"
  if [[ -n "$K8S_RUNTIME_CLASS" ]]; then
    kubectl_cmd get runtimeclass "$K8S_RUNTIME_CLASS" >/dev/null ||
      die "required RuntimeClass not found: $K8S_RUNTIME_CLASS"
  fi
}

verify_deployment_image() {
  local expected actual service_account secret_ref
  expected="$1"
  actual="$(kubectl_cmd -n "$K8S_NAMESPACE" get deployment "$K8S_DEPLOYMENT" \
    -o 'jsonpath={.spec.template.spec.containers[?(@.name=="gateway")].image}')"
  [[ "$actual" == "$expected" ]] ||
    die "deployment image mismatch: expected $expected, got $actual"
  service_account="$(kubectl_cmd -n "$K8S_NAMESPACE" get deployment "$K8S_DEPLOYMENT" \
    -o 'jsonpath={.spec.template.spec.serviceAccountName}')"
  [[ "$service_account" == "$K8S_SERVICE_ACCOUNT" ]] ||
    die "deployment ServiceAccount mismatch: expected $K8S_SERVICE_ACCOUNT, got $service_account"
  secret_ref="$(kubectl_cmd -n "$K8S_NAMESPACE" get deployment "$K8S_DEPLOYMENT" \
    -o 'jsonpath={.spec.template.spec.containers[?(@.name=="gateway")].envFrom[?(@.secretRef.name=="partners-gateway-secrets")].secretRef.name}')"
  [[ "$secret_ref" == "$K8S_SECRET_NAME" ]] ||
    die "deployment Secret reference mismatch: expected $K8S_SECRET_NAME, got $secret_ref"
}

verify_pod_image_digest() {
  local expected_digest image_id
  [[ "$DEPLOY_MODE" == production ]] || return 0
  expected_digest="${1:-$GATEWAY_IMAGE_DIGEST}"
  is_sha256_digest "$expected_digest" ||
    die 'image digest verification requires sha256:<64 hex characters>'
  image_id="$(kubectl_cmd -n "$K8S_NAMESPACE" get pods -l "app=$K8S_DEPLOYMENT" \
    -o 'jsonpath={.items[0].status.containerStatuses[?(@.name=="gateway")].imageID}')"
  [[ "$image_id" == *"@${expected_digest}"* ]] ||
    die "running Pod imageID does not match gateway digest: $image_id"
}

check_gateway_http() {
  local base_url="${K8S_HEALTH_URL%/}" forward_pid='' forward_log='' status=0
  command -v curl >/dev/null || die 'curl is required for Kubernetes health checks'
  if [[ -z "$base_url" ]]; then
    forward_log="$(mktemp)"
    kubectl_cmd -n "$K8S_NAMESPACE" port-forward "service/$K8S_SERVICE" \
      "$K8S_HEALTH_PORT:8080" >"$forward_log" 2>&1 &
    forward_pid=$!
    trap 'kill "$forward_pid" >/dev/null 2>&1 || true; rm -f "$forward_log"' RETURN
    base_url="http://127.0.0.1:$K8S_HEALTH_PORT"
    for _ in {1..30}; do
      curl -fsS "$base_url/health" -o /dev/null && break
      kill -0 "$forward_pid" >/dev/null 2>&1 || {
        sed -n '1,80p' "$forward_log" >&2
        die 'kubectl port-forward exited before health became available'
      }
      sleep 1
    done
  fi
  curl -fsS "$base_url/health" -o /dev/null || status=$?
  curl -fsS "$base_url/ready" -o /dev/null || status=$?
  curl -fsS "$base_url/metrics" -o /dev/null || status=$?
  [[ $status -eq 0 ]] || die 'gateway health, readiness, or metrics check failed'
  if [[ -n "$forward_pid" ]]; then
    kill "$forward_pid" >/dev/null 2>&1 || true
    wait "$forward_pid" >/dev/null 2>&1 || true
    rm -f "$forward_log"
    trap - RETURN
  fi
}

run_gateway_smoke() {
  [[ "$K8S_RUN_SMOKE" == 1 || "$K8S_RUN_SMOKE" == true ]] || {
    log 'Full gateway smoke disabled by K8S_RUN_SMOKE; basic HTTP checks still ran.'
    return 0
  }
  local base_url="${K8S_HEALTH_URL%/}" forward_pid='' forward_log='' smoke_token=''
  if [[ -z "$base_url" ]]; then
    forward_log="$(mktemp)"
    kubectl_cmd -n "$K8S_NAMESPACE" port-forward "service/$K8S_SERVICE" \
      "$K8S_SMOKE_PORT:8080" >"$forward_log" 2>&1 &
    forward_pid=$!
    trap 'kill "$forward_pid" >/dev/null 2>&1 || true; rm -f "$forward_log"' RETURN
    base_url="http://127.0.0.1:$K8S_SMOKE_PORT"
    for _ in {1..30}; do
      curl -fsS "$base_url/health" -o /dev/null && break
      kill -0 "$forward_pid" >/dev/null 2>&1 || {
        sed -n '1,80p' "$forward_log" >&2
        die 'kubectl port-forward exited before full smoke became available'
      }
      sleep 1
    done
  fi
  smoke_token="${GATEWAY_SERVICE_TOKEN:-}"
  if [[ -z "$smoke_token" ]]; then
    smoke_token="$(read_external_secret GATEWAY_SERVICE_TOKEN)"
  fi
  GATEWAY_BASE_URL="$base_url" \
  GATEWAY_SERVICE_TOKEN="$smoke_token" \
  SMOKE_TIMEOUT_MS="$K8S_SMOKE_TIMEOUT_MS" \
  SMOKE_EXPECT_ARTIFACT_BACKEND="${K8S_SMOKE_EXPECT_ARTIFACT_BACKEND:-s3}" \
  SMOKE_RESTART_COMMAND="$K8S_SMOKE_RESTART_COMMAND" \
    npm run gateway:smoke
  if [[ -n "$forward_pid" ]]; then
    kill "$forward_pid" >/dev/null 2>&1 || true
    wait "$forward_pid" >/dev/null 2>&1 || true
    rm -f "$forward_log"
    trap - RETURN
  fi
}

case "$COMMAND" in
  test)
    npm test
    ;;

  compose-smoke)
    cleanup() {
      local status=$?
      if [[ $status -ne 0 ]]; then
        docker compose -f "$COMPOSE_FILE" logs --no-color gateway postgres minio minio-bootstrap || true
      fi
      docker compose -f "$COMPOSE_FILE" down -v --remove-orphans || true
      exit "$status"
    }
    trap cleanup EXIT
    log "Building and starting compose smoke stack"
    IMAGE_TAG="${IMAGE_TAG}" docker compose -f "$COMPOSE_FILE" up -d --build
    log "Running unit tests against repository"
    npm test
    log "Running gateway smoke"
    SMOKE_CHECK_DEPENDENCIES=1 \
    SMOKE_EXPECT_ARTIFACT_BACKEND=s3 \
    SMOKE_RESTART_COMMAND="docker compose -f $COMPOSE_FILE restart gateway" \
      npm run gateway:smoke
    ;;

  build)
    BUILD_DATE="${BUILD_DATE:-$(date -u '+%Y-%m-%dT%H:%M:%SZ')}"
    VCS_REF="${VCS_REF:-$(git rev-parse HEAD 2>/dev/null || echo unknown)}"
    log "Building $IMAGE"
    docker build \
      "${DOCKER_BUILD_ARGS[@]}" \
      -f Dockerfile.gateway \
      --build-arg IMAGE_TAG="$IMAGE_TAG" \
      --build-arg VCS_REF="$VCS_REF" \
      --build-arg BUILD_DATE="$BUILD_DATE" \
      -t "$IMAGE" \
      .
    log "Building $SANDBOX_IMAGE"
    docker build "${DOCKER_BUILD_ARGS[@]}" -f Dockerfile.sandbox -t "$SANDBOX_IMAGE" .
    ;;

  build-sandbox)
    log "Building $SANDBOX_IMAGE"
    docker build "${DOCKER_BUILD_ARGS[@]}" -f Dockerfile.sandbox -t "$SANDBOX_IMAGE" .
    ;;

  push)
    [[ -n "${REGISTRY_USER:-}" && -n "${REGISTRY_PASS:-}" ]] && {
      REGISTRY_HOST="${REGISTRY_HOST:-${IMAGE_REPOSITORY%%/*}}"
      log "Logging in to $REGISTRY_HOST"
      printf '%s' "$REGISTRY_PASS" | docker login "$REGISTRY_HOST" -u "$REGISTRY_USER" --password-stdin
    }
    log "Pushing $IMAGE"
    docker push "$IMAGE"
    log "Pushing $SANDBOX_IMAGE"
    docker push "$SANDBOX_IMAGE"
    ;;

  render-manifest)
    [[ -f "$K8S_MANIFEST" ]] || die "$K8S_MANIFEST not found"
    require_immutable_images
    gateway_image="$(gateway_deploy_image)"
    sandbox_image="$(sandbox_deploy_image)"
    sed -e "s|__IMAGE__|$gateway_image|g" \
      -e "s|__SANDBOX_IMAGE__|$sandbox_image|g" \
      -e "s|__RUNTIME_CLASS__|$K8S_RUNTIME_CLASS|g" "$K8S_MANIFEST"
    ;;

  deploy)
    preflight_k8s
    tmpfile="$(mktemp)"
    trap 'rm -f "$tmpfile"' EXIT
    "$0" render-manifest > "$tmpfile"
    gateway_image="$(gateway_deploy_image)"
    log "Server-side validating $K8S_MANIFEST with image $gateway_image"
    kubectl_cmd apply --server-side --dry-run=server --field-manager=partners-release -f "$tmpfile" >/dev/null
    log "Applying $K8S_MANIFEST with image $gateway_image"
    kubectl_cmd apply --server-side --field-manager=partners-release -f "$tmpfile" >/dev/null
    kubectl_cmd -n "$K8S_NAMESPACE" rollout status "deployment/$K8S_DEPLOYMENT"
    verify_deployment_image "$gateway_image"
    verify_pod_image_digest
    check_gateway_http
    run_gateway_smoke
    ;;

  rollback)
    log "Rolling back deployment/$K8S_DEPLOYMENT in namespace $K8S_NAMESPACE"
    require_k8s_context
    kubectl_cmd -n "$K8S_NAMESPACE" rollout undo "deployment/$K8S_DEPLOYMENT"
    kubectl_cmd -n "$K8S_NAMESPACE" rollout status "deployment/$K8S_DEPLOYMENT"
    if [[ -n "$ROLLBACK_GATEWAY_IMAGE_DIGEST" ]]; then
      verify_pod_image_digest "$ROLLBACK_GATEWAY_IMAGE_DIGEST"
    fi
    check_gateway_http
    run_gateway_smoke
    ;;

  staging-smoke)
    require_k8s_context
    check_gateway_http
    run_gateway_smoke
    ;;

  release)
    "$0" test
    "$0" compose-smoke
    "$0" build
    "$0" push
    log 'Packaging complete; run deploy explicitly with immutable image digests and K8S_CONTEXT.'
    ;;

  help|--help|-h)
    cat <<'USAGE'
Usage: bash scripts/gateway-release.sh <command>

Commands:
  test             Run npm test.
  compose-smoke    Build compose stack, run npm test and gateway smoke, clean up.
  build            Build Dockerfile.gateway with OCI labels.
  build-sandbox    Build the non-privileged sandbox-agent image.
  push             Push gateway and sandbox images.
  render-manifest  Render k8s manifest with tag or immutable digest images.
  deploy           Preflight, server-side validate/apply, and verify rollout.
  rollback         Roll back the deployment and rerun health checks.
  staging-smoke    Run gateway, sandbox, artifact, and session smoke checks.
  release          test, compose-smoke, build, and push (deploy separately).

Environment:
  IMAGE_REPOSITORY=ghcr.io/limmytian/partners-gateway
  SANDBOX_IMAGE_REPOSITORY=ghcr.io/limmytian/partners-sandbox
  IMAGE_TAG=$(git rev-parse --short HEAD)
  DOCKER_PLATFORM=linux/amd64 for a target cluster architecture.
  REGISTRY_USER / REGISTRY_PASS for docker login.
  DEPLOY_MODE=production (default) requires both image digests; use local for tags.
  GATEWAY_IMAGE_DIGEST / SANDBOX_IMAGE_DIGEST=sha256:<64 hex characters>
  K8S_CONTEXT=<explicit kubectl context> for deploy or rollback.
  K8S_RUN_SMOKE=1 (default) runs the full post-rollout gateway smoke.
  K8S_SMOKE_RESTART_COMMAND optionally enables restart-durability checks.
  ROLLBACK_GATEWAY_IMAGE_DIGEST=sha256:<digest> optionally verifies rollback image.
  K8S_MANIFEST=k8s/k8s-partners-gateway.yaml
  K8S_NAMESPACE=partners
  K8S_SECRET_NAME=partners-gateway-secrets (pre-created, never applied)
USAGE
    ;;

  *)
    die "unknown command: $COMMAND"
    ;;
esac
