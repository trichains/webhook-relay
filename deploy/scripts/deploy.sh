#!/usr/bin/env bash
# Blue-green deploy with automatic rollback.
#
#   ./scripts/deploy.sh --build v2                build the image from this checkout and deploy it
#   ./scripts/deploy.sh --image ghcr.io/o/r:v2    deploy a published image (pulled if missing)
#   ./scripts/deploy.sh --rollback                put the previous release back (no migrations;
#                                                 running it again swaps back)
#   ./scripts/deploy.sh --repoint                 rewrite the proxy config for the live color and
#                                                 reload it (e.g. stuck in restore maintenance)
#
# Steps: infra up -> migrations (one-shot job) -> start the idle color -> wait until it is
# healthy -> probe it over the proxy network -> point Caddy at it (graceful reload) -> verify
# through the proxy -> let the old color drain -> stop it. If the new color never gets healthy,
# or anything fails before or right after the switch, the old color keeps (or goes back to)
# serving and the script exits non-zero.
#
# Env knobs: HEALTH_TIMEOUT_SECONDS (120), DRAIN_SECONDS (15), IMAGE_REPO (webhook-relay).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() { sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; }

BUILD=0 ROLLBACK=0 REPOINT=0 IMAGE="" MIGRATE_IMAGE="" TAG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --build) BUILD=1 ;;
    --rollback) ROLLBACK=1 ;;
    --repoint) REPOINT=1 ;;
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

# One deploy at a time (restore.sh takes the same lock).
take_deploy_lock

# The proxy config is the source of truth for what is live; state.env only adds the images.
# (If a previous run was interrupted between the switch and the state update, they could differ.)
ACTIVE=$(live_color_from_proxy)
STATE_ACTIVE=$(state_get ACTIVE_COLOR)
if [ -n "$ACTIVE" ] && [ -n "$STATE_ACTIVE" ] && [ "$ACTIVE" != "$STATE_ACTIVE" ]; then
  say "WARNING: proxy serves $ACTIVE but state.env says $STATE_ACTIVE; trusting the proxy"
  state_set ACTIVE_COLOR "$ACTIVE"
fi
ACTIVE=${ACTIVE:-$STATE_ACTIVE}
if [ "$REPOINT" = 1 ]; then
  [ -n "$ACTIVE" ] || die "no live color known: nothing to repoint"
  write_upstream "$ACTIVE"
  reload_caddy || die "caddy reload failed"
  say "proxy points to app_$ACTIVE"
  exit 0
fi
TARGET=$(other_color "${ACTIVE:-green}") # first deploy goes to blue
ACTIVE_IMAGE=""
[ -n "$ACTIVE" ] && ACTIVE_IMAGE=$(state_get "${ACTIVE^^}_IMAGE")

# ---- 0. resolve the image ----
if [ "$ROLLBACK" = 1 ]; then
  IMAGE=$(state_get PREVIOUS_IMAGE)
  [ -n "$IMAGE" ] || die "no previous image recorded: nothing to roll back to"
  docker image inspect "$IMAGE" >/dev/null 2>&1 || die "previous release image $IMAGE is gone (pruned?)"
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
  if [ -z "$MIGRATE_IMAGE" ]; then
    # Derive <repo>-migrate:<tag> only for a plain trailing tag (not a digest, not a registry port).
    [[ "$IMAGE" =~ ^([^@]+):([A-Za-z0-9_.-]+)$ && "${BASH_REMATCH[2]}" != */* ]] ||
      die "cannot derive the migration image from $IMAGE; pass --migrate-image"
    MIGRATE_IMAGE="${BASH_REMATCH[1]}-migrate:${BASH_REMATCH[2]}"
  fi
  for img in "$IMAGE" "$MIGRATE_IMAGE"; do
    docker image inspect "$img" >/dev/null 2>&1 || docker pull "$img"
  done
fi

# Pin the exact image under an immutable release tag, so rebuilding or re-pulling the same tag
# later can never change what --rollback brings back.
if [ "$ROLLBACK" = 0 ]; then
  RELEASE="$IMAGE_REPO:release-$(date -u +%Y%m%d%H%M%S)"
  docker tag "$IMAGE" "$RELEASE"
  say "deploying $IMAGE as $RELEASE to $TARGET (live: ${ACTIVE:-none})"
else
  RELEASE=$IMAGE
fi

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

export "${TARGET^^}_IMAGE=$RELEASE"
dc up -d --no-deps --force-recreate "app_$TARGET"

say "waiting for app_$TARGET to become healthy (timeout ${HEALTH_TIMEOUT}s)"
deadline=$((SECONDS + HEALTH_TIMEOUT))
while :; do
  id=$(cid "app_$TARGET")
  [ -n "$id" ] || abort_target "container app_$TARGET disappeared"
  read -r status health restarts < <(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{.RestartCount}}' "$id" 2>/dev/null || echo "gone none 0")
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

# ---- 4. switch the proxy and record it, without being interruptible in between ----
trap '' INT TERM HUP
OLD_TARGET_IMAGE=$(state_get "${TARGET^^}_IMAGE")
cp "$UPSTREAM_FILE" "$UPSTREAM_FILE.previous"
write_upstream "$TARGET"
if ! reload_caddy; then
  mv "$UPSTREAM_FILE.previous" "$UPSTREAM_FILE"
  reload_caddy || true
  trap - INT TERM HUP
  abort_target "caddy reload failed"
fi
state_set ACTIVE_COLOR "$TARGET"
state_set "${TARGET^^}_IMAGE" "$RELEASE"
trap - INT TERM HUP
say "proxy now points to app_$TARGET"

# ---- 5. verify through the proxy; on failure point it back ----
ok=0
for _ in 1 2 3 4 5; do
  if probe_live | grep -q '"ok":true'; then ok=$((ok + 1)); fi
  sleep 1
done
if [ "$ok" -lt 5 ]; then
  [ -n "$ACTIVE" ] || abort_target "only $ok/5 health checks passed through the proxy on the first deploy"
  trap '' INT TERM HUP
  write_upstream "$ACTIVE"
  if reload_caddy; then
    state_set ACTIVE_COLOR "$ACTIVE"
    state_set "${TARGET^^}_IMAGE" "$OLD_TARGET_IMAGE"
    trap - INT TERM HUP
    abort_target "only $ok/5 health checks passed through the proxy after the switch; switched back"
  fi
  # Could not switch back: keep the new color running rather than removing what the proxy serves.
  write_upstream "$TARGET"
  die "only $ok/5 checks passed after the switch AND switching back failed: app_$TARGET is still live. Run ./scripts/diagnose.sh now."
fi

state_set DEPLOYED_AT "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if [ -n "$ACTIVE_IMAGE" ]; then state_set PREVIOUS_IMAGE "$ACTIVE_IMAGE"; fi

# ---- 6. drain and stop the old color ----
if [ -n "$ACTIVE" ] && [ -n "$(cid "app_$ACTIVE")" ]; then
  say "draining app_$ACTIVE for ${DRAIN}s, then stopping it (SIGTERM, 30s grace)"
  sleep "$DRAIN"
  dc stop -t 30 "app_$ACTIVE" >/dev/null
fi

# ---- 7. make sure the ops services run ----
dc up -d scheduler backup monitor

say "done: $IMAGE live on $TARGET as $RELEASE"
