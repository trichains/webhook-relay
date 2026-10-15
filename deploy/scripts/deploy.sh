#!/usr/bin/env bash
# Blue-green deploy with automatic rollback.
#
#   ./scripts/deploy.sh --build v2                build the image from this checkout and deploy it
#   ./scripts/deploy.sh --image ghcr.io/o/r:v2    deploy a published image (pulled if missing)
#   ./scripts/deploy.sh --rollback                put the previous image back (no migrations)
#
# Steps: infra up -> migrations (one-shot job) -> start the idle color -> wait until it is
# healthy -> probe it over the proxy network -> point Caddy at it (graceful reload) -> verify
# through the proxy -> let the old color drain -> stop it. If the new color never gets healthy,
# or anything fails before or right after the switch, the old color keeps (or goes back to)
# serving and the script exits non-zero.
#
# Env knobs: HEALTH_TIMEOUT_SECONDS (120), DRAIN_SECONDS (15), IMAGE_REPO (webhook-relay).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() { sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; }

BUILD=0 ROLLBACK=0 IMAGE="" MIGRATE_IMAGE="" TAG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --build) BUILD=1 ;;
    --rollback) ROLLBACK=1 ;;
    --image) IMAGE=${2:?--image needs a value}; shift ;;
    --migrate-image) MIGRATE_IMAGE=${2:?--migrate-image needs a value}; shift ;;
    -h | --help) usage; exit 0 ;;
    -*) die "unknown option $1" ;;
    *) TAG=$1 ;;
  esac
  shift
done

HEALTH_TIMEOUT=${HEALTH_TIMEOUT_SECONDS:-120}
DRAIN=${DRAIN_SECONDS:-15}
IMAGE_REPO=${IMAGE_REPO:-webhook-relay}

# One deploy at a time.
exec 9>"$RUNTIME_DIR/deploy.lock"
flock -n 9 || die "another deploy is running"

ACTIVE=$(state_get ACTIVE_COLOR)
TARGET=$(other_color "${ACTIVE:-green}") # first deploy goes to blue
ACTIVE_IMAGE=""
[ -n "$ACTIVE" ] && ACTIVE_IMAGE=$(state_get "${ACTIVE^^}_IMAGE")

# ---- 0. resolve the image ----
if [ "$ROLLBACK" = 1 ]; then
  IMAGE=$(state_get PREVIOUS_IMAGE)
  [ -n "$IMAGE" ] || die "no previous image recorded: nothing to roll back to"
  docker image inspect "$IMAGE" >/dev/null 2>&1 || docker pull "$IMAGE"
  say "rollback: $ACTIVE ($ACTIVE_IMAGE) -> $TARGET ($IMAGE)"
elif [ "$BUILD" = 1 ]; then
  TAG=${TAG:-$(git -C "$REPO_ROOT" rev-parse --short HEAD)}
  IMAGE="$IMAGE_REPO:$TAG"
  MIGRATE_IMAGE="$IMAGE_REPO-migrate:$TAG"
  say "building $IMAGE and $MIGRATE_IMAGE"
  docker build --build-arg "APP_VERSION=$TAG" --build-arg "NEXT_PUBLIC_APP_URL=https://$(env_get DOMAIN)" \
    -t "$IMAGE" "$REPO_ROOT"
  docker build --target migrator -t "$MIGRATE_IMAGE" "$REPO_ROOT"
else
  if [ -z "$IMAGE" ]; then
    [ -n "$TAG" ] || die "pass a tag, --image, --build or --rollback (see --help)"
    IMAGE="$IMAGE_REPO:$TAG"
  fi
  MIGRATE_IMAGE=${MIGRATE_IMAGE:-"${IMAGE%:*}-migrate:${IMAGE##*:}"}
  for img in "$IMAGE" "$MIGRATE_IMAGE"; do
    docker image inspect "$img" >/dev/null 2>&1 || docker pull "$img"
  done
fi
say "deploying $IMAGE to $TARGET (live: ${ACTIVE:-none})"

# ---- 1. infrastructure ----
[ -f "$UPSTREAM_FILE" ] || write_upstream "$TARGET"
dc up -d --wait postgres
dc up -d caddy

# ---- 2. migrations (skipped on rollback: the schema stays where it is) ----
if [ "$ROLLBACK" = 0 ]; then
  say "running migrations ($MIGRATE_IMAGE)"
  MIGRATE_IMAGE=$MIGRATE_IMAGE dc run --rm -T migrate || die "migrations failed; nothing was switched, ${ACTIVE:-nothing} is still live"
fi

# ---- 3. start the idle color ----
abort_target() {
  local id
  id=$(cid "app_$TARGET")
  if [ -n "$id" ]; then
    say "last log lines of app_$TARGET:"
    docker logs --tail 40 "$id" 2>&1 | sed 's/^/    /' >&2 || true
  fi
  dc rm -sf "app_$TARGET" >/dev/null 2>&1 || true
  die "ROLLBACK: $1. ${ACTIVE:-nothing} is still live${ACTIVE_IMAGE:+ ($ACTIVE_IMAGE)}."
}

export "${TARGET^^}_IMAGE=$IMAGE"
dc up -d --no-deps --force-recreate "app_$TARGET"

say "waiting for app_$TARGET to become healthy (timeout ${HEALTH_TIMEOUT}s)"
deadline=$((SECONDS + HEALTH_TIMEOUT))
while :; do
  id=$(cid "app_$TARGET")
  [ -n "$id" ] || abort_target "container app_$TARGET disappeared"
  read -r status health restarts < <(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{.RestartCount}}' "$id")
  if [ "$status" = "running" ] && [ "$health" = "healthy" ]; then break; fi
  case "$status" in exited | dead) abort_target "app_$TARGET exited during startup" ;; esac
  [ "$restarts" -gt 0 ] && abort_target "app_$TARGET restarted $restarts time(s) during startup"
  [ "$health" = "unhealthy" ] && abort_target "app_$TARGET is unhealthy"
  [ "$SECONDS" -ge "$deadline" ] && abort_target "app_$TARGET not healthy after ${HEALTH_TIMEOUT}s (status=$status health=$health)"
  sleep 1
done
say "app_$TARGET is healthy: $(probe_color "$TARGET" || echo '?')"

# Same check over the network path the proxy will use (DNS name + port), not just inside the container.
probe_color "$TARGET" >/dev/null || abort_target "app_$TARGET is healthy but unreachable from the proxy"

# ---- 4. switch the proxy ----
cp "$UPSTREAM_FILE" "$UPSTREAM_FILE.previous"
write_upstream "$TARGET"
if ! reload_caddy; then
  mv "$UPSTREAM_FILE.previous" "$UPSTREAM_FILE"
  reload_caddy || true
  abort_target "caddy reload failed"
fi
say "proxy now points to app_$TARGET"

# ---- 5. verify through the proxy; on failure point it back ----
ok=0
for _ in 1 2 3 4 5; do
  if body=$(probe_live) && [ "$(jq -r '.ok' <<<"$body" 2>/dev/null)" = "true" ]; then
    ok=$((ok + 1))
  fi
  sleep 1
done
if [ "$ok" -lt 5 ]; then
  if [ -n "$ACTIVE" ]; then
    write_upstream "$ACTIVE"
    reload_caddy || true
  fi
  abort_target "only $ok/5 health checks passed through the proxy after the switch; switched back"
fi

state_set ACTIVE_COLOR "$TARGET"
state_set "${TARGET^^}_IMAGE" "$IMAGE"
state_set DEPLOYED_AT "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if [ -n "$ACTIVE" ] && [ -n "$ACTIVE_IMAGE" ]; then state_set PREVIOUS_IMAGE "$ACTIVE_IMAGE"; fi

# ---- 6. drain and stop the old color ----
if [ -n "$ACTIVE" ] && [ -n "$(cid "app_$ACTIVE")" ]; then
  say "draining app_$ACTIVE for ${DRAIN}s, then stopping it (SIGTERM, 30s grace)"
  sleep "$DRAIN"
  dc stop -t 30 "app_$ACTIVE" >/dev/null
fi

# ---- 7. make sure the ops services run ----
dc up -d scheduler backup monitor

say "done: $IMAGE live on $TARGET"
