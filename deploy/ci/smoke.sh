#!/usr/bin/env bash
# End-to-end smoke test of the deployed stack, from outside (HTTPS through Caddy):
# redirect, TLS, health, auth, signed webhook -> delivered to the built-in sink, and the
# scheduler draining a queued delivery through the proxy's internal listener.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

fail() {
  say "SMOKE FAILED: $*"
  exit 1
}

code=$(curl -s -o /dev/null -w '%{http_code}' http://localhost/api/health)
[ "$code" = "308" ] || fail "http should redirect to https (got $code)"

issuer=$(echo | openssl s_client -connect localhost:443 -servername localhost 2>/dev/null | openssl x509 -noout -issuer)
grep -q "Caddy Local Authority" <<<"$issuer" || fail "unexpected certificate issuer: $issuer"

health=$(curl -sk "$BASE_URL/api/health")
[ "$(jq -r .ok <<<"$health")" = "true" ] || fail "health: $health"
[ "$(jq -r .driver <<<"$health")" = "pg" ] || fail "expected the Postgres driver, got: $health"

code=$(curl -sk -o /dev/null -w '%{http_code}' "$BASE_URL/dashboard")
[ "$code" = "401" ] || fail "dashboard without credentials should be 401 (got $code)"
code=$(curl -sk -o /dev/null -w '%{http_code}' "$BASE_URL/api/v1/events")
[ "$code" = "401" ] || fail "management API without token should be 401 (got $code)"

ensure_ci_source

# Secrets in requests must not reach the proxy logs (Hotmart's hottok: header or query string).
canary="hottok-canary-$RANDOM$RANDOM"
curl -sk -o /dev/null -H "x-hotmart-hottok: $canary" "$BASE_URL/api/ingest/no-such-source?hottok=$canary" || true
sleep 1
leaks=$(dc logs --no-color caddy 2>/dev/null | grep -c "$canary" || true)
[ "$leaks" = "0" ] || fail "hottok canary found $leaks time(s) in the Caddy logs"

# 1) signed webhook -> 202 -> delivered by the first attempt (runs in after())
started=$(date +%s%N)
code=$(send_webhook "smoke-$(date +%s)" /tmp/smoke-ingest.json)
[ "$code" = "202" ] || fail "ingest returned $code: $(cat /tmp/smoke-ingest.json)"
event_id=$(jq -r .eventId /tmp/smoke-ingest.json)
delivered() { [ "$(api "/api/v1/events/$event_id" | jq -r .status)" = "delivered" ]; }
wait_until 30 delivered || fail "event $event_id not delivered: $(api "/api/v1/events/$event_id")"
latency=$(awk -v a="$started" -v b="$(date +%s%N)" 'BEGIN {printf "%.2f", (b - a) / 1e9}')
attempt=$(api "/api/v1/events/$event_id" | jq -c '.deliveries[0] | {destination: .destination.url, status, code: .attempts[0].statusCode}')
say "event $event_id delivered: $attempt"

# Sign with a wrong secret: verification must reject it.
bad_code=$(CI_SECRET=wrong send_webhook "smoke-bad-sig")
[ "$bad_code" = "401" ] || fail "wrong signature should be 401 (got $bad_code)"

# 2) scheduler: queue a delivery directly in the database and wait for the worker to send it.
psql_q -q -c "
  insert into destinations (id, source_id, name, url, max_attempts, timeout_ms)
  values ('dst_ci_sched', 'src_ci', 'Scheduler check', '/api/sink/ok', 6, 10000) on conflict (id) do nothing;
  insert into deliveries (id, event_id, destination_id, status, next_attempt_at)
  values ('dlv_ci_sched', '$event_id', 'dst_ci_sched', 'pending', now()) on conflict (id) do nothing;" >/dev/null
sched_started=$SECONDS
sched_done() { [ "$(psql_q -At -c "select status from deliveries where id = 'dlv_ci_sched'")" = "succeeded" ]; }
wait_until 60 sched_done || fail "scheduler did not deliver the queued delivery"
sched_s=$((SECONDS - sched_started))

{
  echo "### Smoke test"
  echo "| check | result |"
  echo "|---|---|"
  echo "| http → https | 308 |"
  echo "| certificate issuer | Caddy Local Authority (tls internal) |"
  echo "| health | ok, driver=pg, version=$(jq -r .version <<<"$health") |"
  echo "| dashboard / API without credentials | 401 / 401 |"
  echo "| signed webhook → delivered to /api/sink/ok | ${latency}s ($attempt) |"
  echo "| wrong signature | 401 |"
  echo "| hottok (header + query) in proxy logs | redacted (0 occurrences) |"
  echo "| queued delivery picked up by the scheduler | ${sched_s}s |"
} | tee -a "$SUMMARY"
say "smoke ok"
