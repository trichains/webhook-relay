#!/usr/bin/env bash
# One backup: pg_dump (custom format) -> verify it is readable -> atomic rename -> checksum ->
# retention (keep the newest BACKUP_KEEP dumps). Prints the backup path on stdout on success.
set -euo pipefail
export OPS_SERVICE=backup
source /ops/common.sh

DIR=${BACKUP_DIR:-/backups}
KEEP=${BACKUP_KEEP:-14}
mkdir -p "$DIR"
# Millisecond timestamp: two backups in the same second (e.g. restore.sh's safety backup right
# after a manual one) must never get the same name.
name="${PGDATABASE}-$(date -u +%Y%m%dT%H%M%S.%3NZ).dump"
tmp="$DIR/.${name}.partial"
trap 'rm -f "$tmp"' EXIT

started=$(date +%s)
pg_dump --format=custom --no-owner --file="$tmp"
pg_restore --list "$tmp" >/dev/null # an unreadable dump is a failed backup and never rotates in
# Never replace an existing dump (mv -n would fail silently; check explicitly).
[ ! -e "$DIR/$name" ] || { log error backup.name_collision "$name already exists" >&2; exit 1; }
mv "$tmp" "$DIR/$name"
(cd "$DIR" && sha256sum "$name" >"$name.sha256")

# Retention: newest first, delete everything after the first $KEEP.
ls -1t "$DIR"/*.dump 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  rm -f "$old" "$old.sha256"
  log info backup.pruned "$(basename "$old")" >&2
done

size=$(du -h "$DIR/$name" | cut -f1)
log info backup.done "$name size=${size} seconds=$(($(date +%s) - started))" >&2
echo "$DIR/$name"
