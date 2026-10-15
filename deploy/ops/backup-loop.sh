#!/usr/bin/env bash
# Scheduled backups. A failure is logged and retried on the next tick; the monitor alerts when
# the newest dump gets older than BACKUP_MAX_AGE_SECONDS.
set -uo pipefail
export OPS_SERVICE=backup
source /ops/common.sh

INTERVAL=${BACKUP_INTERVAL_SECONDS:-86400}
log info backup.scheduler_started "every ${INTERVAL}s, keep ${BACKUP_KEEP:-14}"
# On start, only back up if the newest dump is older than the interval: a restart loop must not
# rotate the daily history out with near-identical dumps.
newest=$(ls -1t "${BACKUP_DIR:-/backups}"/*.dump 2>/dev/null | head -n 1)
wait_s=0
if [ -n "$newest" ]; then
  age=$(($(date +%s) - $(stat -c %Y "$newest")))
  [ "$age" -lt "$INTERVAL" ] && wait_s=$((INTERVAL - age))
fi
until pg_isready -q; do sleep 2; done
while true; do
  if [ "$wait_s" -gt 0 ]; then sleep "$wait_s"; fi
  wait_s=$INTERVAL
  /ops/backup.sh >/dev/null || log error backup.failed "scheduled backup failed"
done
