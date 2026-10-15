#!/usr/bin/env bash
# Writes deploy/.env for the CI lab: localhost with Caddy's internal CA, random secrets, fast
# scheduler/monitor intervals and the mock alert receiver. Never used for a real server.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

secret() {
  local v
  v=$(openssl rand -hex "${1:-24}")
  [ -n "${GITHUB_ACTIONS:-}" ] && echo "::add-mask::$v" >&2
  echo "$v"
}

cp .env.example .env
set_var() {
  local key=$1 value=$2
  if grep -q "^$key=" .env; then
    sed -i "s|^$key=.*|$key=$value|" .env
  else
    echo "$key=$value" >>.env
  fi
}
set_var DOMAIN localhost
set_var CADDY_TLS internal
set_var POSTGRES_PASSWORD "$(secret 16)"
set_var RELAY_ADMIN_TOKEN "$(secret)"
set_var CRON_SECRET "$(secret)"
set_var CI_SOURCE_SECRET "whsec_$(secret 16)"
set_var SCHEDULER_INTERVAL_SECONDS 3
set_var BACKUP_INTERVAL_SECONDS 3600
set_var ALERT_WEBHOOK_URL http://alert-sink:9000/hook
set_var INSTANCE_NAME ci-lab
set_var MONITOR_INTERVAL_SECONDS 3
set_var MONITOR_FAILURES_BEFORE_ALERT 3
set_var MONITOR_STARTUP_DELAY_SECONDS 5
# GitHub runners keep the root disk fairly full; this lab is not about disk alerts.
set_var DISK_MAX_PERCENT 98
echo "deploy/.env written for the CI lab"
