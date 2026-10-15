#!/usr/bin/env bash
# Restores a dump from deploy/backups into the stack's Postgres.
#
#   ./scripts/restore.sh backups/relay-20261015T030000.000Z.dump    asks for confirmation
#   ./scripts/restore.sh --yes relay-20261015T030000.000Z.dump      no prompt (automation)
#
# Steps:
#  1. takes the deploy lock (no deploy or second restore can run meanwhile)
#  2. pins a private copy of the dump and reads its expected sha256 up front
#  3. puts the proxy in maintenance: every request gets 503 + Retry-After, so webhook senders
#     retry later instead of getting a 202 for an event the restore would then erase; the
#     scheduler (which goes through the proxy) pauses too
#  4. takes a safety backup of the current state (without retention, so it can never prune
#     the dump being restored)
#  5. restores the pinned copy in a single transaction (all or nothing)
#  6. points the proxy back at the live color
#
# If the restore fails, the pinned copy is kept and its path printed.
# The pin exists because of docs/incidents/2026-10-15-restore-overwritten-by-safety-backup.md.
#
# Restore a dump into the schema version it was taken from: after newer migrations, deploy the
# release that matches the dump first (or restore into an empty database). See the runbook.
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

take_deploy_lock

# Pin: a dotfile copy is invisible to retention (*.dump glob) and to new backups' names.
pinned=".restore-$$-$name"
expected=""
if [ -f "$BACKUP_HOST_DIR/$name.sha256" ]; then expected=$(cut -d' ' -f1 "$BACKUP_HOST_DIR/$name.sha256"); fi
in_backup cp "/backups/$name" "/backups/$pinned"

color=$(live_color_from_proxy)
restored=0
finish() {
  if [ -n "$color" ]; then
    write_upstream "$color"
    if reload_caddy; then
      say "maintenance off: proxy serves app_$color again"
    else
      say "WARNING: could not reload Caddy; run: ./scripts/dc.sh exec caddy caddy reload --config /etc/caddy/Caddyfile"
    fi
  fi
  if [ "$restored" = 1 ]; then
    in_backup rm -f "/backups/$pinned" >/dev/null 2>&1 || true
  else
    say "restore did not complete; the pinned copy is kept at $BACKUP_HOST_DIR/$pinned"
  fi
}
trap finish EXIT

if [ -n "$color" ]; then
  write_maintenance "$color"
  reload_caddy || die "could not put the proxy in maintenance"
  say "maintenance on: proxy answers 503 + Retry-After; waiting ${MAINTENANCE_DRAIN_SECONDS:-5}s for in-flight requests"
  sleep "${MAINTENANCE_DRAIN_SECONDS:-5}"
fi

if [ "$SAFETY" = 1 ]; then
  say "safety backup of the current state first"
  "$(dirname "${BASH_SOURCE[0]}")/backup.sh" --no-prune >/dev/null
fi

say "restoring $name${expected:+ (sha256 ${expected:0:12}...)}"
in_backup /ops/restore.sh "/backups/$pinned" "$expected"
restored=1
say "restore ok"
