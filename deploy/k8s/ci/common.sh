#!/usr/bin/env bash
# Helpers for the Kubernetes lab checks (.github/workflows/k8s-lab.yml). Sourced.
# Traffic goes through the ingress (http://localhost -> kind node port 80 -> ingress-nginx -> pods).
source "$(dirname "${BASH_SOURCE[0]}")/../scripts/lib.sh"
need kubectl helm jq curl openssl

BASE_URL=${BASE_URL:-http://localhost}
export SUMMARY=${GITHUB_STEP_SUMMARY:-/dev/stderr}
ADMIN_TOKEN=$(lab_secret adminToken)
CI_SOURCE=ci-smoke
if [ ! -s "$LAB_DIR/ci-source-secret" ]; then
  (umask 077 && echo "whsec_$(openssl rand -hex 16)" >"$LAB_DIR/ci-source-secret")
fi
CI_SECRET=$(cat "$LAB_DIR/ci-source-secret")
if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::add-mask::$CI_SECRET"; fi

# Markdown for the job summary, also echoed to the log (the summary is per step).
report() { tee -a "$SUMMARY" >&2; }

psql_q() {
  kn exec -i "$DB_RELEASE-0" -c postgres -- \
    sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -v ON_ERROR_STOP=1 "$@"' psql "$@"
}

# CI source (HMAC) with one destination on the built-in /api/sink/ok receiver.
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
  curl -s -m 10 -o "$out" -w '%{http_code}' \
    -H 'content-type: application/json' -H "x-signature: t=$ts,v1=$sig" \
    --data "$body" "$BASE_URL/api/ingest/$CI_SOURCE" || true
}

api() { curl -s -m 10 -H "authorization: Bearer $ADMIN_TOKEN" "$BASE_URL$1"; }

web_pods() { kn get pods -l "app.kubernetes.io/instance=$RELEASE,app.kubernetes.io/component=web" "$@"; }
ready_web_pods() {
  web_pods -o json | jq -r '.items[] | select(.metadata.deletionTimestamp == null)
    | select(any(.status.conditions[]?; .type == "Ready" and .status == "True")) | .metadata.name'
}

# Background traffic through the ingress: N health workers + 1 signed-webhook worker.
# load_start <dir>; ...; load_stop <dir> -> prints key=value totals.
load_start() {
  local dir=$1 workers=${LOAD_WORKERS:-4} i
  rm -rf "$dir" && mkdir -p "$dir"
  for i in $(seq 1 "$workers"); do
    (
      while [ ! -f "$dir/stop" ]; do
        curl -s -o /dev/null -m 5 -w '%{http_code} %{time_total}\n' "$BASE_URL/api/health" >>"$dir/health-$i.log" 2>/dev/null || true
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
  # Runs inside $(...): `wait` cannot see the workers there, so poll until each one has exited
  # (docs/incidents/2026-10-15-load-counter-race.md).
  while read -r pid; do
    while kill -0 "$pid" 2>/dev/null; do sleep 0.1; done
  done <"$dir/pids"
  cat "$dir"/health-*.log >"$dir/health.all"
  local h_total h_ok i_total i_ok p_max
  h_total=$(wc -l <"$dir/health.all")
  h_ok=$(awk '$1 == 200' "$dir/health.all" | wc -l)
  p_max=$(awk 'BEGIN {m = 0} $2 > m {m = $2} END {printf "%.3f", m}' "$dir/health.all")
  i_total=$(wc -l <"$dir/ingest.log")
  i_ok=$(awk '$1 == 202 || $1 == 200' "$dir/ingest.log" | wc -l)
  echo "health_total=$h_total health_ok=$h_ok health_errors=$((h_total - h_ok)) health_max_s=$p_max ingest_total=$i_total ingest_ok=$i_ok ingest_errors=$((i_total - i_ok))"
  if [ "$((h_total - h_ok))" -gt 0 ] || [ "$((i_total - i_ok))" -gt 0 ]; then
    echo "non-OK responses:" >&2
    cat "$dir"/health-*.log "$dir/ingest.log" | awk '$1 != 200 && $1 != 202' | sort | uniq -c >&2
  fi
}

# Delivery outcome of the webhooks a load run accepted: "delivered pending other".
load_deliveries() {
  psql_q -At -F ' ' -c "
    select count(*) filter (where status = 'delivered'),
           count(*) filter (where status = 'pending'),
           count(*) filter (where status not in ('delivered', 'pending'))
    from events where source_id = 'src_ci' and payload->>'id' like 'load-$(basename "$1")-%'"
}

# Waits until every webhook accepted during a load run has been delivered (first attempt in
# after(), retries by the scheduler CronJob). Prints "delivered pending other".
wait_deliveries() {
  local dir=$1 end=$((SECONDS + ${2:-150})) counts
  while :; do
    counts=$(load_deliveries "$dir")
    [ "$(cut -d' ' -f2 <<<"$counts")" = 0 ] && break
    [ "$SECONDS" -lt "$end" ] || break
    sleep 2
  done
  echo "$counts"
}
