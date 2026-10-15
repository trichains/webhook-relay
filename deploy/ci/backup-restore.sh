#!/usr/bin/env bash
# Backup/restore test: generate data, back up, wipe it, restore, compare row counts.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

counts() {
  psql_q -At -c "select (select count(*) from sources) || ' ' || (select count(*) from destinations) || ' ' ||
    (select count(*) from events) || ' ' || (select count(*) from deliveries) || ' ' || (select count(*) from attempts)"
}

ensure_ci_source
for i in $(seq 1 25); do
  code=$(send_webhook "backup-$i-$RANDOM")
  [ "$code" = "202" ] || { say "ingest $i returned $code"; exit 1; }
done
settled() { [ "$(psql_q -At -c "select count(*) from deliveries where status in ('pending','processing')")" = "0" ]; }
wait_until 60 settled || { say "deliveries did not settle"; exit 1; }

before=$(counts)
say "before backup (sources destinations events deliveries attempts): $before"
started=$SECONDS
file=$("$DEPLOY_DIR/scripts/backup.sh")
backup_s=$((SECONDS - started))
size=$(du -h "$file" | cut -f1)
sha_before=$(sha256sum "$file" | cut -d' ' -f1)

psql_q -q -c "delete from sources;" >/dev/null # cascades to destinations, events, deliveries, attempts
wiped=$(counts)
say "after wipe: $wiped"
[ "$wiped" = "0 0 0 0 0" ] || { say "wipe did not remove everything"; exit 1; }

started=$SECONDS
"$DEPLOY_DIR/scripts/restore.sh" --yes "$file"
restore_s=$((SECONDS - started))
after=$(counts)
say "after restore: $after"
health=$(curl -sk "$BASE_URL/api/health" | jq -r .ok)

read -r s d e dl a <<<"$before"
{
  echo "### Backup / restore"
  echo "| metric | value |"
  echo "|---|---|"
  echo "| rows before (sources / destinations / events / deliveries / attempts) | $s / $d / $e / $dl / $a |"
  echo "| backup | $(basename "$file"), $size, ${backup_s}s (custom format + sha256) |"
  echo "| after wipe | $wiped |"
  echo "| restore | ${restore_s}s (single transaction, safety backup first) |"
  echo "| rows after restore | $(tr ' ' '/' <<<"$after" | sed 's|/| / |g') |"
  echo "| counts match | $([ "$before" = "$after" ] && echo '**yes**' || echo '**NO**') |"
} | tee -a "$SUMMARY"

[ "$before" = "$after" ] || { say "row counts differ after restore"; exit 1; }
# Regression (docs/incidents/2026-10-15-restore-overwritten-by-safety-backup.md): the safety
# backup taken by restore.sh must not replace or prune the dump that was restored.
[ "$(sha256sum "$file" | cut -d' ' -f1)" = "$sha_before" ] || { say "the restored dump was modified on disk"; exit 1; }
[ "$health" = "true" ] || { say "app unhealthy after restore"; exit 1; }
# The restored data is usable, not just present: a new webhook on the restored source is accepted.
[ "$(send_webhook "after-restore-$RANDOM")" = "202" ] || { say "ingest failed after restore"; exit 1; }
say "backup/restore ok"
