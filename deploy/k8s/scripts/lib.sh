#!/usr/bin/env bash
# Shared settings and helpers for the Kubernetes lab scripts. Sourced, not executed.
set -euo pipefail

K8S_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
REPO_ROOT=$(cd "$K8S_DIR/../.." && pwd)
LAB_DIR="$K8S_DIR/.lab" # generated secrets; gitignored
export K8S_DIR REPO_ROOT LAB_DIR

CLUSTER=${CLUSTER:-webhook-relay-lab}
NAMESPACE=${NAMESPACE:-relay}
RELEASE=${RELEASE:-relay}
DB_RELEASE=${DB_RELEASE:-relay-postgres}
APP_CHART="$K8S_DIR/chart/webhook-relay"
DB_CHART="$K8S_DIR/chart/postgres-lab"
export APP_CHART DB_CHART

# Pinned versions. ingress-nginx is retired upstream (no releases after March 2026); v1.15.1 is
# its last release and supports Kubernetes 1.31-1.35, hence the 1.35 node image.
KIND_NODE_IMAGE=${KIND_NODE_IMAGE:-kindest/node:v1.35.8@sha256:07b2536e30b803ed61d1677a79df6115f798ce64c80f9e22f6ed45afd09323c0}
INGRESS_NGINX_VERSION=${INGRESS_NGINX_VERSION:-controller-v1.15.1}
METRICS_SERVER_VERSION=${METRICS_SERVER_VERSION:-v0.9.0}

say() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die() {
  say "ERROR: $*"
  exit 1
}

need() {
  local bin
  for bin in "$@"; do
    command -v "$bin" >/dev/null 2>&1 || die "'$bin' is required (see docs/kubernetes-lab.md, Running it locally)"
  done
}

k() { kubectl --context "kind-$CLUSTER" "$@"; }
kn() { k -n "$NAMESPACE" "$@"; }
h() { helm --kube-context "kind-$CLUSTER" "$@"; }

# Version label reported by the live pods through the ingress (APP_VERSION baked into the image).
live_version() { curl -s -m 5 "${BASE_URL:-http://localhost}/api/health" | jq -r '.version // "?"' 2>/dev/null || echo "?"; }

# Image tag of the Deployment's current pod template.
deployed_tag() { kn get deploy "$RELEASE" -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null | sed 's/.*://'; }

# wait_until <seconds> <command...>: polls once per second.
wait_until() {
  local timeout=$1
  shift
  local end=$((SECONDS + timeout))
  until "$@"; do
    [ "$SECONDS" -lt "$end" ] || return 1
    sleep 1
  done
}

# Reads a key from the generated lab secrets file (flat YAML written by deploy.sh).
lab_secret() { sed -n "s/^  $1: \"\{0,1\}\([^\"]*\)\"\{0,1\}$/\1/p" "$LAB_DIR/secrets.yaml" | tail -n 1; }
