#!/usr/bin/env bash
# Queue worker trigger: replaces Vercel Cron when self-hosting. Calls /api/cron/deliver through the
# proxy's internal listener, so it always reaches whichever color (blue/green) is live.
set -uo pipefail
export OPS_SERVICE=scheduler
source /ops/common.sh

URL=${CRON_URL:-http://caddy:8080/api/cron/deliver}
INTERVAL=${SCHEDULER_INTERVAL_SECONDS:-30}
: "${CRON_SECRET:?CRON_SECRET is required}"

log info scheduler.started "every ${INTERVAL}s -> ${URL}"
while true; do
  out=$(curl -sS -m 90 -w '\n%{http_code}' -H "authorization: Bearer ${CRON_SECRET}" "$URL" 2>&1)
  code=${out##*$'\n'}
  body=${out%$'\n'*}
  if [ "$code" = "200" ]; then
    # Only log ticks that did work, so an idle queue does not flood the logs.
    claimed=$(jq -r '.claimed // .processed // 0' <<<"$body" 2>/dev/null || echo "?")
    if [ "$claimed" != "0" ]; then log info scheduler.tick "$body"; fi
  else
    log error scheduler.tick_failed "status=${code} body=$(head -c 300 <<<"$body")"
  fi
  sleep "$INTERVAL"
done
