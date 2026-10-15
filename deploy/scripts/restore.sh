#!/usr/bin/env bash
# Restores a dump from deploy/backups into the stack's Postgres.
#
#   ./scripts/restore.sh backups/relay-20261015T030000.000Z.dump          asks for confirmation
#   ./scripts/restore.sh --yes relay-20261015T030000.000Z.dump            no prompt (automation)
#
# What it does: pins a private copy of the dump and checks it against its .sha256, takes a
# safety backup of the current state, pauses the scheduler (no deliveries mid-restore), restores
# the pinned copy in a single transaction (all-or-nothing), resumes the scheduler. The app keeps
# running; requests that touch the tables wait for the restore transaction to commit.
#
# The pinned copy matters: the safety backup and its retention must never be able to replace or
# delete the file being restored (docs/incidents/2026-10-15-restore-overwritten-by-safety-backup.md).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

YES=0 SAFETY=1 FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --yes | -y) YES=1 ;;
    --no-safety-backup) SAFETY=0 ;;
    -*) die "unknown option $1" ;;
    *) FILE=$1 ;;
  esac
  shift
done
[ -n "$FILE" ] || die "usage: restore.sh [--yes] [--no-safety-backup] <backups/file.dump>"

name=$(basename "$FILE")
[ -f "$BACKUP_HOST_DIR/$name" ] || die "$name not found in $BACKUP_HOST_DIR (copy off-site dumps there first)"

if [ "$YES" != 1 ]; then
  read -r -p "Restore $name over the current database? This replaces its data. [y/N] " answer
  [ "$answer" = "y" ] || [ "$answer" = "Y" ] || die "aborted"
fi

# Pin: a dotfile copy is invisible to retention (*.dump glob) and to new backups' names.
pinned=".restore-$$-$name"
expected=""
[ -f "$BACKUP_HOST_DIR/$name.sha256" ] && expected=$(cut -d' ' -f1 "$BACKUP_HOST_DIR/$name.sha256")
in_backup cp "/backups/$name" "/backups/$pinned"
cleanup_pin() { in_backup rm -f "/backups/$pinned" >/dev/null 2>&1 || true; }
trap cleanup_pin EXIT

if [ "$SAFETY" = 1 ]; then
  say "safety backup of the current state first"
  "$(dirname "${BASH_SOURCE[0]}")/backup.sh" >/dev/null
fi

scheduler_was_running=0
if [ -n "$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter label=com.docker.compose.service=scheduler)" ]; then
  scheduler_was_running=1
  dc stop scheduler >/dev/null
fi
resume() { if [ "$scheduler_was_running" = 1 ]; then dc start scheduler >/dev/null || say "WARNING: could not restart the scheduler"; fi; }
trap 'resume; cleanup_pin' EXIT

say "restoring $name${expected:+ (sha256 ${expected:0:12}...)}"
in_backup /ops/restore.sh "/backups/$pinned" "$expected"
say "restore ok"
