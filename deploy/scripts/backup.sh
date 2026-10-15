#!/usr/bin/env bash
# On-demand backup (the `backup` service also runs them on a schedule).
# Prints the host path of the new dump. Retention: BACKUP_KEEP newest dumps (deploy/.env).
#
#   ./scripts/backup.sh
#
# Off-site copy: see docs/self-hosting.md ("Off-site backups").
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

if [ -n "$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter label=com.docker.compose.service=backup)" ]; then
  path=$(dc exec -T backup /ops/backup.sh)
else
  path=$(dc run --rm -T --no-deps backup /ops/backup.sh)
fi
path=$(tail -n 1 <<<"$path" | tr -d '\r')
host_path="$BACKUP_HOST_DIR/$(basename "$path")"
[ -f "$host_path" ] || die "backup reported $path but $host_path does not exist"
say "backup ok: $host_path ($(du -h "$host_path" | cut -f1))"
echo "$host_path"
