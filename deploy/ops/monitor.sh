#!/usr/bin/env bash
# Health and queue monitor. Every MONITOR_INTERVAL_SECONDS it runs the checks below; a check has
# to fail MONITOR_FAILURES_BEFORE_ALERT times in a row before it alerts (debounce), a firing
# alert is repeated at most every ALERT_REPEAT_SECONDS, and recovery sends one "resolved".
#
# Alert payload (ALERT_FORMAT=json, default) is a generic JSON object: Discord reads `content`,
# Slack-style hooks read `text`, custom receivers get status/check/message. ALERT_FORMAT=text posts
# plain text, which is what ntfy expects (POST https://ntfy.sh/<topic>).
set -uo pipefail
export OPS_SERVICE=monitor
source /ops/common.sh

INTERVAL=${MONITOR_INTERVAL_SECONDS:-30}
THRESHOLD=${MONITOR_FAILURES_BEFORE_ALERT:-3}
REPEAT=${ALERT_REPEAT_SECONDS:-3600}
HEALTH_URL=${HEALTH_URL:-http://caddy:8080/api/health}
QUEUE_STUCK=${QUEUE_STUCK_SECONDS:-900}
QUEUE_MAX=${QUEUE_MAX_PENDING:-1000}
DISK_PATH=${DISK_PATH:-/backups}
DISK_MAX=${DISK_MAX_PERCENT:-90}
BACKUP_DIR=${BACKUP_DIR:-/backups}
BACKUP_MAX_AGE=${BACKUP_MAX_AGE_SECONDS:-93600}
INSTANCE=${INSTANCE_NAME:-webhook-relay}

declare -A fails=() firing=() last_sent=()

send() {
  local status=$1 check=$2 msg=$3 text body ctype
  text="[${INSTANCE}] ${status^^} ${check}: ${msg}"
  if [ -z "${ALERT_WEBHOOK_URL:-}" ]; then
    log warn alert.not_configured "$text"
    return 0
  fi
  if [ "${ALERT_FORMAT:-json}" = "text" ]; then
    body=$text
    ctype="text/plain"
  else
    body=$(jq -cn --arg s "$status" --arg c "$check" --arg m "$msg" --arg i "$INSTANCE" --arg t "$text" \
      '{content:$t, text:$t, status:$s, check:$c, message:$m, instance:$i, ts:(now|floor|todate)}')
    ctype="application/json"
  fi
  # The webhook URL often embeds a token (Discord): it goes to curl on stdin, not as an argument.
  if curl_cfg url "$ALERT_WEBHOOK_URL" | curl -fsS -m 10 -X POST -H "content-type: ${ctype}" --data "$body" -K - >/dev/null; then
    log info alert.sent "$text"
  else
    log error alert.send_failed "$text"
  fi
}

evaluate() {
  local check=$1 ok=$2 msg=$3 now
  now=$(date +%s)
  if [ "$ok" = "1" ]; then
    if [ "${firing[$check]:-0}" = "1" ]; then send resolved "$check" "$msg"; fi
    fails[$check]=0
    firing[$check]=0
    return
  fi
  fails[$check]=$((${fails[$check]:-0} + 1))
  log warn check.failed "${check} (${fails[$check]}/${THRESHOLD}): ${msg}"
  if [ "${fails[$check]}" -ge "$THRESHOLD" ]; then
    if [ "${firing[$check]:-0}" != "1" ] || [ $((now - ${last_sent[$check]:-0})) -ge "$REPEAT" ]; then
      send firing "$check" "$msg"
      firing[$check]=1
      last_sent[$check]=$now
    fi
  fi
}

check_health() {
  local out code body
  out=$(curl -sS -m 5 -w '\n%{http_code}' "$HEALTH_URL" 2>&1)
  code=${out##*$'\n'}
  body=${out%$'\n'*}
  if [ "$code" = "200" ] && [ "$(jq -r '.ok' <<<"$body" 2>/dev/null)" = "true" ]; then
    evaluate health 1 "health check OK ($(jq -r '.version // "no version"' <<<"$body"))"
  else
    evaluate health 0 "GET ${HEALTH_URL} -> status=${code} body=$(head -c 200 <<<"$body")"
  fi
}

check_queue() {
  local row pending overdue
  if ! row=$(psql -Atq -v ON_ERROR_STOP=1 -c "select count(*) filter (where status in ('pending','processing')), count(*) filter (where status = 'pending' and next_attempt_at < now() - make_interval(secs => ${QUEUE_STUCK})) from deliveries" 2>&1); then
    evaluate database 0 "query failed: $(head -c 200 <<<"$row")"
    return
  fi
  evaluate database 1 "database reachable"
  IFS='|' read -r pending overdue <<<"$row"
  if [ "${overdue:-0}" -gt 0 ]; then
    evaluate queue 0 "${overdue} deliveries overdue by more than ${QUEUE_STUCK}s (${pending} in queue): is the scheduler running?"
  elif [ "${pending:-0}" -gt "$QUEUE_MAX" ]; then
    evaluate queue 0 "${pending} deliveries in queue (limit ${QUEUE_MAX})"
  else
    evaluate queue 1 "queue OK (${pending} in queue)"
  fi
}

check_disk() {
  local used
  used=$(df -P "$DISK_PATH" | awk 'NR==2 {gsub("%","",$5); print $5}')
  if [ "${used:-0}" -ge "$DISK_MAX" ]; then
    evaluate disk 0 "disk ${used}% used on the host filesystem of ${DISK_PATH} (limit ${DISK_MAX}%)"
  else
    evaluate disk 1 "disk ${used}% used"
  fi
}

check_backup() {
  local newest age
  newest=$(ls -1t "$BACKUP_DIR"/*.dump 2>/dev/null | head -n 1)
  if [ -z "$newest" ]; then
    evaluate backup 0 "no backup found in ${BACKUP_DIR}"
    return
  fi
  age=$(($(date +%s) - $(stat -c %Y "$newest")))
  if [ "$age" -gt "$BACKUP_MAX_AGE" ]; then
    evaluate backup 0 "newest backup $(basename "$newest") is ${age}s old (limit ${BACKUP_MAX_AGE}s)"
  else
    evaluate backup 1 "newest backup $(basename "$newest") is ${age}s old"
  fi
}

log info monitor.started "every ${INTERVAL}s, alert after ${THRESHOLD} failures, webhook $([ -n "${ALERT_WEBHOOK_URL:-}" ] && echo set || echo 'NOT set')"
# Give the stack a moment on first boot so a cold start does not page anyone.
sleep "${MONITOR_STARTUP_DELAY_SECONDS:-20}"
while true; do
  check_health
  check_queue
  check_disk
  check_backup
  sleep "$INTERVAL"
done
