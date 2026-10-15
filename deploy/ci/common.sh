#!/usr/bin/env bash
# Helpers for the self-hosting CI checks (.github/workflows/selfhost.yml). Sourced.
source "$(dirname "${BASH_SOURCE[0]}")/../scripts/lib.sh"

BASE_URL=${BASE_URL:-https://localhost}
CI_SOURCE=ci-smoke
CI_SECRET=$(env_get CI_SOURCE_SECRET)
ADMIN_TOKEN=$(env_get RELAY_ADMIN_TOKEN)
export SUMMARY=${GITHUB_STEP_SUMMARY:-/dev/stderr}

psql_q() { dc exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -v ON_ERROR_STOP=1 "$@"' psql "$@"; }

# Creates the CI source (HMAC) with one destination on the built-in /api/sink/ok receiver.
ensure_ci_source() {
  psql_q -q -c "
    insert into sources (id, name, slug, scheme, secret, event_type_path)
    values ('src_ci', 'CI smoke', '$CI_SOURCE', 'hmac-sha256', '$CI_SECRET', 'event')
    on conflict (slug) do nothing;
    insert into destinations (id, source_id, name, url, max_attempts, timeout_ms)
    values ('dst_ci_ok', 'src_ci', 'Built-in sink (ok)', '/api/sink/ok', 6, 10000)
    on conflict (id) do nothing;" >/dev/null
}

# send_webhook <id> [outfile]: signed POST to /api/ingest/ci-smoke, prints the HTTP status.
send_webhook() {
  local id=$1 out=${2:-/dev/null} body ts sig
  body=$(printf '{"event":"order.paid","id":"%s","amount_cents":4990}' "$id")
  ts=$(date +%s)
  sig=$(printf '%s.%s' "$ts" "$body" | openssl dgst -sha256 -hmac "$CI_SECRET" -r | cut -d' ' -f1)
  curl -sk -m 10 -o "$out" -w '%{http_code}' \
    -H 'content-type: application/json' -H "x-signature: t=$ts,v1=$sig" \
    --data "$body" "$BASE_URL/api/ingest/$CI_SOURCE" || true
}

api() { curl -sk -m 10 -H "authorization: Bearer $ADMIN_TOKEN" "$BASE_URL$1"; }

live_version() { curl -sk -m 5 "$BASE_URL/api/health" | jq -r '.version // "?"'; }

# Background load: N health workers + 1 ingest worker hitting the public HTTPS endpoint.
# load_start <dir>; ...; load_stop <dir> -> prints key=value totals.
load_start() {
  local dir=$1 workers=${LOAD_WORKERS:-4} i
  rm -rf "$dir" && mkdir -p "$dir"
  for i in $(seq 1 "$workers"); do
    (
      while [ ! -f "$dir/stop" ]; do
        curl -sk -o /dev/null -m 5 -w '%{http_code} %{time_total}\n' "$BASE_URL/api/health" >>"$dir/health-$i.log" 2>/dev/null || true
        sleep 0.05
      done
    ) &
    echo $! >>"$dir/pids"
  done
  (
    n=0
    while [ ! -f "$dir/stop" ]; do
      n=$((n + 1))
      echo "$(send_webhook "load-$(basename "$dir")-$n-$RANDOM$RANDOM")" >>"$dir/ingest.log"
      sleep 0.2
    done
  ) &
  echo $! >>"$dir/pids"
}

load_stop() {
  local dir=$1 pid
  touch "$dir/stop"
  while read -r pid; do wait "$pid" 2>/dev/null || true; done <"$dir/pids"
  local h_total h_ok i_total i_ok p_max
  h_total=$(cat "$dir"/health-*.log | wc -l)
  h_ok=$(cat "$dir"/health-*.log | awk '$1 == 200' | wc -l)
  p_max=$(cat "$dir"/health-*.log | awk 'BEGIN {m = 0} $2 > m {m = $2} END {printf "%.3f", m}')
  i_total=$(wc -l <"$dir/ingest.log")
  i_ok=$(awk '$1 == 202 || $1 == 200' "$dir/ingest.log" | wc -l)
  echo "health_total=$h_total health_ok=$h_ok health_errors=$((h_total - h_ok)) health_max_s=$p_max ingest_total=$i_total ingest_ok=$i_ok ingest_errors=$((i_total - i_ok))"
  if [ "$((h_total - h_ok))" -gt 0 ] || [ "$((i_total - i_ok))" -gt 0 ]; then
    echo "non-OK responses:" >&2
    cat "$dir"/health-*.log "$dir/ingest.log" | awk '$1 != 200 && $1 != 202' | sort | uniq -c >&2
  fi
}

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
