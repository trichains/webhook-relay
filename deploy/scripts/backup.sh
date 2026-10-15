#!/usr/bin/env bash
# On-demand backup (the `backup` service also runs them on a schedule).
# Prints the host path of the new dump. Retention: BACKUP_KEEP newest dumps (deploy/.env).
#
#   ./scripts/backup.sh
#   ./scripts/backup.sh --no-prune     skip retention (restore.sh uses it for its safety backup)
#
# Off-site copy: see docs/self-hosting.md ("Off-site backups").
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

prune=1
[ "${1:-}" = "--no-prune" ] && prune=0
path=$(in_backup env "BACKUP_PRUNE=$prune" /ops/backup.sh)
path=$(tail -n 1 <<<"$path" | tr -d '\r')
host_path="$BACKUP_HOST_DIR/$(basename "$path")"
[ -f "$host_path" ] || die "backup reported $path but $host_path does not exist"
say "backup ok: $host_path ($(du -h "$host_path" | cut -f1))"
echo "$host_path"
