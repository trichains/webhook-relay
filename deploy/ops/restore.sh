#!/usr/bin/env bash
# Restores a dump produced by backup.sh into $PGDATABASE. Drops and recreates the objects the dump
# contains in a single transaction: either everything is restored or nothing changes.
set -euo pipefail
export OPS_SERVICE=backup
source /ops/common.sh

# usage: restore.sh /backups/<file>.dump [expected-sha256]
file=${1:?usage: restore.sh /backups/<file>.dump [expected-sha256]}
expected=${2:-}
[ -f "$file" ] || { log error restore.missing "$file"; exit 1; }
if [ -n "$expected" ]; then
  actual=$(sha256sum "$file" | cut -d' ' -f1)
  [ "$actual" = "$expected" ] || {
    log error restore.checksum_mismatch "$file: expected $expected, got $actual"
    exit 1
  }
elif [ -f "$file.sha256" ]; then
  (cd "$(dirname "$file")" && sha256sum -c --quiet "$(basename "$file").sha256") || {
    log error restore.checksum_mismatch "$file"
    exit 1
  }
fi
started=$(date +%s)
pg_restore --clean --if-exists --no-owner --single-transaction --exit-on-error --dbname="$PGDATABASE" "$file"
log info restore.done "$(basename "$file") seconds=$(($(date +%s) - started))"
