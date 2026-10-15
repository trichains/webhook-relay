#!/usr/bin/env bash
# Scheduled backups. A failure is logged and retried on the next tick; the monitor alerts when
# the newest dump gets older than BACKUP_MAX_AGE_SECONDS.
set -uo pipefail
OPS_SERVICE=backup
source /ops/common.sh

INTERVAL=${BACKUP_INTERVAL_SECONDS:-86400}
log info backup.scheduler_started "every ${INTERVAL}s, keep ${BACKUP_KEEP:-14}"
if [ "${BACKUP_ON_START:-1}" = "1" ]; then
  until pg_isready -q; do sleep 2; done
  /ops/backup.sh >/dev/null || log error backup.failed "initial backup failed"
fi
while true; do
  sleep "$INTERVAL"
  /ops/backup.sh >/dev/null || log error backup.failed "scheduled backup failed"
done
