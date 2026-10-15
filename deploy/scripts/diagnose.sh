#!/usr/bin/env bash
# Quick production snapshot for incident triage (read-only). Paste the output into the incident
# notes. See docs/runbook.md for what to do with each section.
#
#   ./scripts/diagnose.sh               last 30 minutes of logs
#   SINCE=2h ./scripts/diagnose.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
set +e # a diagnostic keeps going when one probe fails

SINCE=${SINCE:-30m}
section() { printf '\n===== %s =====\n' "$*"; }
psql_q() { dc exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -P pager=off "$@"' psql "$@"; }

section "deploy state"
cat "$STATE_FILE"
echo "upstream: $(grep -o 'app_[a-z]*:3000' "$UPSTREAM_FILE" 2>/dev/null || echo 'not written yet')"

section "containers"
dc ps -a --format 'table {{.Service}}\t{{.State}}\t{{.Status}}\t{{.Image}}'
for svc in app_blue app_green; do
  id=$(cid "$svc")
  [ -n "$id" ] || continue
  docker inspect -f "$svc: status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{end}} restarts={{.RestartCount}} oom_killed={{.State.OOMKilled}} exit={{.State.ExitCode}} started={{.State.StartedAt}}" "$id"
done

section "health through the proxy"
probe_live || echo "FAILED: proxy -> live app health check"
echo
ACTIVE=$(state_get ACTIVE_COLOR)
[ -n "$ACTIVE" ] && { probe_color "$ACTIVE" || echo "FAILED: direct check of app_$ACTIVE"; }
echo

section "app errors (since $SINCE)"
for svc in app_blue app_green; do
  [ -n "$(cid "$svc")" ] || continue
  dc logs --no-color --no-log-prefix --since "$SINCE" "$svc" 2>/dev/null | grep -E '"level":"(error|warn)"|Error|ECONNREFUSED' | tail -n 20 | sed "s/^/$svc | /"
done

section "proxy 5xx and TLS/ACME messages (since $SINCE)"
dc logs --no-color --no-log-prefix --since "$SINCE" caddy 2>/dev/null |
  grep -E '"status":5[0-9][0-9]|"level":"error"|acme|certificate|tls' | tail -n 20

section "scheduler / monitor / backup (since $SINCE)"
for svc in scheduler monitor backup; do
  dc logs --no-color --no-log-prefix --since "$SINCE" "$svc" 2>/dev/null | grep -E '"level":"(error|warn)"|alert' | tail -n 8 | sed "s/^/$svc | /"
done

section "postgres connections"
psql_q -c "select coalesce(application_name,'') as app, state, count(*) from pg_stat_activity where datname = current_database() group by 1,2 order by 3 desc;"
psql_q -At -c "select 'max_connections=' || setting from pg_settings where name = 'max_connections';"
psql_q -c "select pid, now() - query_start as running_for, state, left(query, 80) as query from pg_stat_activity where datname = current_database() and state <> 'idle' and now() - query_start > interval '5 seconds' order by 2 desc limit 5;"

section "delivery queue"
psql_q -c "select status, count(*), min(next_attempt_at) filter (where status = 'pending') as oldest_due from deliveries group by 1 order by 1;"
psql_q -c "select count(*) as overdue_5min from deliveries where status = 'pending' and next_attempt_at < now() - interval '5 minutes';"
psql_q -c "select coalesce(last_error, 'HTTP ' || last_status_code) as last_error, count(*) from deliveries where status in ('pending','dead_letter') and (last_error is not null or last_status_code is not null) group by 1 order by 2 desc limit 5;"

section "disk"
df -h / "$DEPLOY_DIR" 2>/dev/null | awk '!seen[$0]++'
docker system df
echo "postgres data: $(psql_q -At -c "select pg_size_pretty(pg_database_size(current_database()));" 2>/dev/null)"

section "backups"
ls -1t "$BACKUP_HOST_DIR"/*.dump 2>/dev/null | head -n 3 | while read -r f; do
  echo "$(basename "$f")  $(du -h "$f" | cut -f1)  $(date -u -r "$f" +%Y-%m-%dT%H:%M:%SZ)"
done
[ -n "$(ls "$BACKUP_HOST_DIR"/*.dump 2>/dev/null)" ] || echo "NO BACKUPS in $BACKUP_HOST_DIR"
