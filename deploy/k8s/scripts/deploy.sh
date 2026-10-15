#!/usr/bin/env bash
# Deploys (or upgrades) webhook-relay on the lab cluster with Helm.
#
#   deploy/k8s/scripts/deploy.sh --build v1      build both images, load them into kind, install
#   deploy/k8s/scripts/deploy.sh v2              images webhook-relay:v2 / -migrate:v2 already built
#   deploy/k8s/scripts/deploy.sh v2 -- --set autoscaling.maxReplicas=8    extra helm args
#   HELM_TIMEOUT=90s deploy/k8s/scripts/deploy.sh broken
#
# The upgrade runs with --wait --atomic: Helm waits for the migration hook and for the rollout to
# become Ready, and if anything fails or times out it rolls the release back by itself.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need docker kind kubectl helm jq openssl

build=false
if [ "${1:-}" = "--build" ]; then
  build=true
  shift
fi
TAG=${1:?usage: deploy.sh [--build] <tag> [-- extra helm args]}
shift
[ "${1:-}" = "--" ] && shift
APP_IMAGE="webhook-relay:$TAG"
MIGRATE_IMAGE="webhook-relay-migrate:$TAG"

if $build; then
  say "building $APP_IMAGE and $MIGRATE_IMAGE"
  docker build -q -t "$APP_IMAGE" --build-arg APP_VERSION="$TAG" "$REPO_ROOT" >/dev/null
  docker build -q -t "$MIGRATE_IMAGE" --target migrator "$REPO_ROOT" >/dev/null
fi
for img in "$APP_IMAGE" "$MIGRATE_IMAGE"; do
  docker image inspect "$img" >/dev/null 2>&1 || die "image $img not found (use --build)"
done

# No registry in the lab: images are copied into the kind node's containerd.
say "loading images into kind"
kind load docker-image --name "$CLUSTER" "$APP_IMAGE" "$MIGRATE_IMAGE" >/dev/null

k create namespace "$NAMESPACE" --dry-run=client -o yaml | k apply -f - >/dev/null

# Lab secrets: generated once, outside git (deploy/k8s/.lab is gitignored).
mkdir -p "$LAB_DIR"
if [ ! -s "$LAB_DIR/secrets.yaml" ]; then
  umask 077
  printf 'secrets:\n  adminToken: "%s"\n  cronSecret: "%s"\n' "$(openssl rand -hex 24)" "$(openssl rand -hex 24)" >"$LAB_DIR/secrets.yaml"
  say "generated $LAB_DIR/secrets.yaml"
fi
if [ -n "${GITHUB_ACTIONS:-}" ]; then
  echo "::add-mask::$(lab_secret adminToken)"
  echo "::add-mask::$(lab_secret cronSecret)"
fi

say "database release $DB_RELEASE (postgres-lab)"
h upgrade --install "$DB_RELEASE" "$DB_CHART" -n "$NAMESPACE" --wait --timeout 3m >/dev/null

say "helm upgrade --install $RELEASE ($TAG) --wait --atomic --timeout ${HELM_TIMEOUT:-5m}"
started=$SECONDS
h upgrade --install "$RELEASE" "$APP_CHART" -n "$NAMESPACE" \
  -f "$LAB_DIR/secrets.yaml" \
  --set image.tag="$TAG" \
  --wait --atomic --timeout "${HELM_TIMEOUT:-5m}" "$@" >/dev/null
say "helm finished in $((SECONDS - started))s"

# With the HPA on, the Deployment has no replicas field: on the first install it starts with one
# pod and the HPA raises it to minReplicas within a sync period. Wait for that.
min=$(kn get hpa "$RELEASE" -o jsonpath='{.spec.minReplicas}' 2>/dev/null || true)
min=${min:-1}
enough_ready() { [ "$(kn get deploy "$RELEASE" -o jsonpath='{.status.readyReplicas}')" -ge "$min" ] 2>/dev/null; }
wait_until 120 enough_ready || die "fewer than $min ready replicas"
kn rollout status deploy/"$RELEASE" --timeout=120s >/dev/null

rev=$(h status "$RELEASE" -n "$NAMESPACE" -o json | jq -r .version)
say "deployed $TAG: helm revision $rev, $(kn get deploy "$RELEASE" -o jsonpath='{.status.readyReplicas}') ready replicas"
