#!/usr/bin/env bash
# Shared helpers for the deploy scripts. Sourced, not executed.
set -euo pipefail

DEPLOY_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
REPO_ROOT=$(cd "$DEPLOY_DIR/.." && pwd)
export REPO_ROOT # used by deploy.sh (sourced)
RUNTIME_DIR="$DEPLOY_DIR/runtime"
STATE_FILE="$RUNTIME_DIR/state.env"
UPSTREAM_FILE="$RUNTIME_DIR/caddy/upstream.caddy"
BACKUP_HOST_DIR="$DEPLOY_DIR/backups"
PROJECT=webhook-relay

say() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die() {
  say "ERROR: $*"
  exit 1
}

for bin in docker flock; do
  command -v "$bin" >/dev/null 2>&1 || die "'$bin' is required on the host (see docs/self-hosting.md, Requirements)"
done
docker compose version >/dev/null 2>&1 || die "the Docker Compose plugin is required (docker compose version)"
[ -f "$DEPLOY_DIR/.env" ] || die "missing $DEPLOY_DIR/.env (copy .env.example and fill it in)"
mkdir -p "$RUNTIME_DIR/caddy" "$BACKUP_HOST_DIR"
touch "$STATE_FILE"

# docker compose with the stack's files. app_blue/app_green/migrate live in profiles; commands that
# inspect or stop things see every profile, while `up`/`run`/`create` only touch what they name.
dc() {
  local files=(-f "$DEPLOY_DIR/compose.yaml") extra
  for extra in ${COMPOSE_EXTRA_FILES:-}; do files+=(-f "$extra"); done
  local profiles=${COMPOSE_PROFILES:-}
  case "${1:-}" in
    up | run | create) ;;
    *) profiles=blue,green,migrate ;;
  esac
  COMPOSE_PROFILES=$profiles docker compose --project-directory "$DEPLOY_DIR" "${files[@]}" \
    --env-file "$DEPLOY_DIR/.env" --env-file "$STATE_FILE" "$@"
}

# Container id of a compose service (running or not), without depending on active profiles.
cid() {
  docker ps -aq --filter "label=com.docker.compose.project=$PROJECT" \
    --filter "label=com.docker.compose.service=$1" | head -n 1
}

state_get() { sed -n "s/^$1=//p" "$STATE_FILE" | tail -n 1; }

state_set() {
  local key=$1 value=$2 tmp
  tmp=$(mktemp "$RUNTIME_DIR/.state.XXXXXX")
  grep -v "^$key=" "$STATE_FILE" >"$tmp" || true
  printf '%s=%s\n' "$key" "$value" >>"$tmp"
  mv "$tmp" "$STATE_FILE"
}

env_get() { sed -n "s/^$1=//p" "$DEPLOY_DIR/.env" | tail -n 1; }

other_color() { [ "$1" = "blue" ] && echo green || echo blue; }

# Serialize deploy.sh and restore.sh (fd 9 stays open until the script exits).
take_deploy_lock() {
  exec 9>"$RUNTIME_DIR/deploy.lock"
  flock -n 9 || die "another deploy or restore is running"
}

# Color the proxy currently serves (or would serve, when in maintenance), from upstream.caddy.
live_color_from_proxy() {
  [ -f "$UPSTREAM_FILE" ] || return 0
  sed -En 's/^# .*Live color: (blue|green).*/\1/p' "$UPSTREAM_FILE" | head -n 1
}

# Maintenance: Caddy answers 503 + Retry-After for everything, so webhook senders retry later and
# nothing new is written. Used by restore.sh; the app containers keep running.
write_maintenance() {
  local color=$1
  cat >"$UPSTREAM_FILE.tmp" <<EOF
# Managed by scripts/restore.sh: MAINTENANCE. Live color: $color
header Retry-After 120
respond "maintenance: restore in progress, retry later" 503
EOF
  mv "$UPSTREAM_FILE.tmp" "$UPSTREAM_FILE"
}

write_upstream() {
  local color=$1
  cat >"$UPSTREAM_FILE.tmp" <<EOF
# Managed by scripts/deploy.sh. Live color: $color
reverse_proxy app_$color:3000 {
	# Ride out a short blip (e.g. a container restart) instead of answering 502 right away.
	lb_try_duration 5s
	lb_try_interval 250ms
	fail_duration 5s
}
EOF
  mv "$UPSTREAM_FILE.tmp" "$UPSTREAM_FILE"
}

reload_caddy() {
  dc exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
}

# Runs a command in the backup service (has pg_dump/pg_restore, PG* env and /backups mounted):
# exec into the running container, or a one-off container when the service is stopped.
in_backup() {
  if [ -n "$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter label=com.docker.compose.service=backup)" ]; then
    dc exec -T backup "$@"
  else
    dc run --rm -T --no-deps backup "$@"
  fi
}

# GET /api/health of a color from inside the proxy container (same network path Caddy uses).
probe_color() {
  dc exec -T caddy wget -q -T 5 -O - "http://app_$1:3000/api/health" 2>/dev/null
}

# GET /api/health through Caddy's internal listener (whatever is live).
probe_live() {
  dc exec -T caddy wget -q -T 5 -O - "http://127.0.0.1:8080/api/health" 2>/dev/null
}
