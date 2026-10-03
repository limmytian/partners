#!/usr/bin/env bash
set -euo pipefail

COMMAND="${1:-help}"
CONSOLE_IMAGE_REPOSITORY="${CONSOLE_IMAGE_REPOSITORY:-ghcr.io/limmytian/partners-console}"
IMAGE_TAG="${IMAGE_TAG:-$(git rev-parse --short HEAD 2>/dev/null || echo local)}"
IMAGE="${CONSOLE_IMAGE_REPOSITORY}:${IMAGE_TAG}"
CONSOLE_IMAGE_DIGEST="${CONSOLE_IMAGE_DIGEST:-}"
K8S_MANIFEST="${K8S_MANIFEST:-k8s/k8s-partners-console.yaml}"
K8S_NAMESPACE="${K8S_NAMESPACE:-partners}"
K8S_DEPLOYMENT="${K8S_DEPLOYMENT:-partners-console}"
K8S_SERVICE="${K8S_SERVICE:-partners-console}"
K8S_CONTEXT="${K8S_CONTEXT:-}"
K8S_HEALTH_PORT="${K8S_HEALTH_PORT:-13000}"
GATEWAY_URL="${GATEWAY_URL:-http://partners-gateway:8080}"
ROLLBACK_CONSOLE_IMAGE_DIGEST="${ROLLBACK_CONSOLE_IMAGE_DIGEST:-}"
DEPLOY_MODE="${DEPLOY_MODE:-production}"
REGISTRY_HOST="${REGISTRY_HOST:-${CONSOLE_IMAGE_REPOSITORY%%/*}}"

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
  is_sha256_digest "$CONSOLE_IMAGE_DIGEST" ||
    die 'production deployment requires CONSOLE_IMAGE_DIGEST=sha256:<64 hex characters>'
}

console_deploy_image() {
  if [[ "$DEPLOY_MODE" == production ]]; then
    printf '%s:%s@%s' "$CONSOLE_IMAGE_REPOSITORY" "$IMAGE_TAG" "$CONSOLE_IMAGE_DIGEST"
  else
    printf '%s' "$IMAGE"
  fi
}

require_k8s_context() {
  [[ -n "$K8S_CONTEXT" ]] || die 'K8S_CONTEXT must be set for a Kubernetes operation'
  local context_rows
  context_rows="$(kubectl_cmd config get-contexts "$K8S_CONTEXT" --no-headers 2>/dev/null || true)"
  [[ -n "$context_rows" ]] ||
    die "Kubernetes context not found: $K8S_CONTEXT"
}

preflight_k8s() {
  require_immutable_images
  [[ "$CONSOLE_IMAGE_REPOSITORY" == "$REGISTRY_HOST/"* ]] ||
    die "console image repository is outside REGISTRY_HOST=$REGISTRY_HOST"
  require_k8s_context
  kubectl_cmd get namespace "$K8S_NAMESPACE" >/dev/null ||
    die "required namespace not found: $K8S_NAMESPACE"
}

verify_deployment_image() {
  local expected actual
  expected="$1"
  actual="$(kubectl_cmd -n "$K8S_NAMESPACE" get deployment "$K8S_DEPLOYMENT" \
    -o 'jsonpath={.spec.template.spec.containers[?(@.name=="console")].image}')"
  [[ "$actual" == "$expected" ]] ||
    die "deployment image mismatch: expected $expected, got $actual"
}

verify_pod_image_digest() {
  local expected_digest image_id
  [[ "$DEPLOY_MODE" == production ]] || return 0
  expected_digest="${1:-$CONSOLE_IMAGE_DIGEST}"
  is_sha256_digest "$expected_digest" ||
    die 'image digest verification requires sha256:<64 hex characters>'
  image_id="$(kubectl_cmd -n "$K8S_NAMESPACE" get pods -l "app=$K8S_DEPLOYMENT" \
    -o 'jsonpath={.items[0].status.containerStatuses[?(@.name=="console")].imageID}')"
  [[ "$image_id" == *"@${expected_digest}"* ]] ||
    die "running Pod imageID does not match console digest: $image_id"
}

check_console_http() {
  local forward_pid='' forward_log='' status=0 base_url=''
  command -v curl >/dev/null || die 'curl is required for Kubernetes health checks'

  forward_log="$(mktemp)"
  kubectl_cmd -n "$K8S_NAMESPACE" port-forward "service/$K8S_SERVICE" \
    "$K8S_HEALTH_PORT:3000" >"$forward_log" 2>&1 &
  forward_pid=$!
  trap 'kill "$forward_pid" >/dev/null 2>&1 || true; rm -f "$forward_log"' RETURN
  base_url="http://127.0.0.1:$K8S_HEALTH_PORT"

  for _ in {1..30}; do
    curl -fsS "$base_url/health" -o /dev/null 2>/dev/null && break
    kill -0 "$forward_pid" >/dev/null 2>&1 || {
      sed -n '1,80p' "$forward_log" >&2
      die 'kubectl port-forward exited before console health became available'
    }
    sleep 1
  done

  curl -fsS "$base_url/health" -o /dev/null || status=$?
  # Verify index.html is served
  curl -fsS "$base_url/" -o /dev/null || status=$?
  [[ $status -eq 0 ]] || die 'console health or index.html check failed'

  log "Console HTTP health check passed on $base_url"

  if [[ -n "$forward_pid" ]]; then
    kill "$forward_pid" >/dev/null 2>&1 || true
    wait "$forward_pid" >/dev/null 2>&1 || true
    rm -f "$forward_log"
    trap - RETURN
  fi
}

case "$COMMAND" in
  build)
    BUILD_DATE="${BUILD_DATE:-$(date -u '+%Y-%m-%dT%H:%M:%SZ')}"
    VCS_REF="${VCS_REF:-$(git rev-parse HEAD 2>/dev/null || echo unknown)}"
    log "Building $IMAGE"
    docker build \
      "${DOCKER_BUILD_ARGS[@]}" \
      -f Dockerfile.console \
      --build-arg IMAGE_TAG="$IMAGE_TAG" \
      --build-arg VCS_REF="$VCS_REF" \
      --build-arg BUILD_DATE="$BUILD_DATE" \
      -t "$IMAGE" \
      .
    ;;

  push)
    [[ -n "${REGISTRY_USER:-}" && -n "${REGISTRY_PASS:-}" ]] && {
      REGISTRY_HOST="${REGISTRY_HOST:-${CONSOLE_IMAGE_REPOSITORY%%/*}}"
      log "Logging in to $REGISTRY_HOST"
      printf '%s' "$REGISTRY_PASS" | docker login "$REGISTRY_HOST" -u "$REGISTRY_USER" --password-stdin
    }
    log "Pushing $IMAGE"
    docker push "$IMAGE"
    ;;

  render-manifest)
    [[ -f "$K8S_MANIFEST" ]] || die "$K8S_MANIFEST not found"
    require_immutable_images
    console_image="$(console_deploy_image)"
    sed -e "s|__CONSOLE_IMAGE__|$console_image|g" \
      -e "s|__GATEWAY_URL__|$GATEWAY_URL|g" "$K8S_MANIFEST"
    ;;

  deploy)
    preflight_k8s
    tmpfile="$(mktemp)"
    trap 'rm -f "$tmpfile"' EXIT
    "$0" render-manifest > "$tmpfile"
    console_image="$(console_deploy_image)"
    log "Server-side validating $K8S_MANIFEST with image $console_image"
    kubectl_cmd apply --server-side --dry-run=server --field-manager=partners-console-release -f "$tmpfile" >/dev/null
    log "Applying $K8S_MANIFEST with image $console_image"
    kubectl_cmd apply --server-side --field-manager=partners-console-release -f "$tmpfile" >/dev/null
    kubectl_cmd -n "$K8S_NAMESPACE" rollout status "deployment/$K8S_DEPLOYMENT"
    verify_deployment_image "$console_image"
    verify_pod_image_digest
    check_console_http
    log "Console deployment and health verification completed successfully."
    ;;

  rollback)
    log "Rolling back deployment/$K8S_DEPLOYMENT in namespace $K8S_NAMESPACE"
    require_k8s_context
    kubectl_cmd -n "$K8S_NAMESPACE" rollout undo "deployment/$K8S_DEPLOYMENT"
    kubectl_cmd -n "$K8S_NAMESPACE" rollout status "deployment/$K8S_DEPLOYMENT"
    if [[ -n "$ROLLBACK_CONSOLE_IMAGE_DIGEST" ]]; then
      verify_pod_image_digest "$ROLLBACK_CONSOLE_IMAGE_DIGEST"
    fi
    check_console_http
    log "Console rollback completed successfully."
    ;;

  smoke)
    require_k8s_context
    check_console_http
    ;;

  help|--help|-h)
    cat <<'USAGE'
Usage: bash scripts/console-release.sh <command>

Commands:
  build            Build Dockerfile.console with OCI labels.
  push             Push console image to registry.
  render-manifest  Render k8s console manifest with tag or immutable digest image.
  deploy           Preflight, server-side validate/apply, and verify rollout.
  rollback         Roll back console deployment and rerun health check.
  smoke            Run port-forward and check /health and index page.

Environment:
  CONSOLE_IMAGE_REPOSITORY=ghcr.io/limmytian/partners-console
  IMAGE_TAG=$(git rev-parse --short HEAD)
  DOCKER_PLATFORM=linux/amd64 for target architecture.
  REGISTRY_USER / REGISTRY_PASS for docker login.
  DEPLOY_MODE=production (default, requires CONSOLE_IMAGE_DIGEST); use local for tags.
  CONSOLE_IMAGE_DIGEST=sha256:<64 hex characters>
  GATEWAY_URL=http://partners-gateway:8080
  K8S_CONTEXT=<explicit kubectl context> for deploy or rollback.
  K8S_MANIFEST=k8s/k8s-partners-console.yaml
  K8S_NAMESPACE=partners
  K8S_DEPLOYMENT=partners-console
  K8S_HEALTH_PORT=13000
USAGE
    ;;

  *)
    die "unknown command: $COMMAND"
    ;;
esac
