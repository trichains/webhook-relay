#!/usr/bin/env bash
# Alert test: take the live app down, expect exactly one "firing" health alert at the mock
# receiver (debounced, no spam), bring it back, expect one "resolved" and a healthy stack.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

alerts() { curl -s -m 5 http://127.0.0.1:9000/alerts; }
count_alerts() { alerts | jq --arg s "$1" '[.[] | select(.body.check == "health" and .body.status == $s)] | length'; }

active=$(state_get ACTIVE_COLOR)
firing_before=$(count_alerts firing)
resolved_before=$(count_alerts resolved)

say "stopping app_$active (simulated outage)"
down_at=$SECONDS
dc stop -t 10 "app_$active" >/dev/null
public_code=$(curl -sk -o /dev/null -m 15 -w '%{http_code}' "$BASE_URL/api/health" || true)

fired() { [ "$(count_alerts firing)" -gt "$firing_before" ]; }
wait_until 90 fired || { say "no firing alert within 90s"; alerts; exit 1; }
alert_s=$((SECONDS - down_at))
say "alert received after ${alert_s}s: $(alerts | jq -c '[.[] | select(.body.status == "firing")][-1].body')"

# Stay down a little longer: a debounced monitor must not send the same alert again.
sleep 15
firing_total=$(($(count_alerts firing) - firing_before))
failed_checks=$(dc logs --no-color --no-log-prefix --since "$((SECONDS - down_at + 2))s" monitor 2>/dev/null | grep -c '"event":"check.failed".*"detail":"health' || true)

say "starting app_$active again"
up_at=$SECONDS
dc start "app_$active" >/dev/null
healthy() { [ "$(curl -sk -m 5 "$BASE_URL/api/health" | jq -r .ok 2>/dev/null)" = "true" ]; }
wait_until 90 healthy || { say "app did not come back"; exit 1; }
recovered_s=$((SECONDS - up_at))
resolved() { [ "$(count_alerts resolved)" -gt "$resolved_before" ]; }
wait_until 60 resolved || { say "no resolved alert"; alerts; exit 1; }
resolved_s=$((SECONDS - up_at))
sample=$(alerts | jq -c '[.[] | select(.body.check == "health")][-1].body | {status, check, message, instance}')

{
  echo "### Alerting (live app stopped)"
  echo "| metric | value |"
  echo "|---|---|"
  echo "| public /api/health while down | HTTP $public_code |"
  echo "| time to firing alert at the mock receiver | ${alert_s}s (3 failures × 3s interval) |"
  echo "| failed health checks logged while down | $failed_checks |"
  echo "| firing alerts sent (debounce) | **$firing_total** |"
  echo "| app healthy again after restart | ${recovered_s}s |"
  echo "| resolved alert received | ${resolved_s}s after restart |"
  echo "| last alert payload | \`$sample\` |"
} | tee -a "$SUMMARY"

[ "$firing_total" = 1 ] || { say "expected exactly 1 firing alert, got $firing_total"; exit 1; }
say "alert ok"
