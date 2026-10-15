# Runbook: webhook-relay self-hosted

[Português](runbook.pt-BR.md) · [Self-hosting guide](self-hosting.md) · [Incidents](incidents/)

Commands run from `deploy/` on the server. `./scripts/dc.sh` is `docker compose` for this stack.

## How to work an incident

1. **Snapshot first, change later.** `./scripts/diagnose.sh > /tmp/diag-$(date +%s).txt`. It is
   read-only and captures what a restart would erase (logs, connection states, restart counts).
2. **Stop the bleeding** if users are affected: `./scripts/deploy.sh --rollback` when it started
   with a deploy; restart a crashed service otherwise. Webhook senders retry, and every accepted
   event is in Postgres, so a short outage loses nothing once ingest is back.
3. **Find the root cause** with the matching section below. A restart that "fixes" it is a
   symptom treatment; write down why it broke.
4. **Fix the cause, then verify** with the same command that showed the problem.
5. **Write it up** in `docs/incidents/` (template: [the first incident](incidents/)): timeline,
   impact, root cause, fix, what prevents a repeat.

Useful everywhere:

```bash
./scripts/dc.sh ps -a                                        # what runs, health, restarts
./scripts/dc.sh logs --no-log-prefix --since 30m app_green | jq -c 'select(.level=="error")'
./scripts/dc.sh exec postgres psql -U relay relay            # SQL shell
cat runtime/state.env; cat runtime/caddy/upstream.caddy      # which color is live
```

---

## 1. 502 Bad Gateway from the proxy

**Symptoms.** `curl -i https://DOMAIN/api/health` returns `502`; monitor fires `health`; senders
see 502 and start retrying.

**Investigate.**

```bash
cat runtime/caddy/upstream.caddy                    # which app_<color> Caddy proxies to
./scripts/dc.sh ps -a app_blue app_green            # is that color running? healthy? restarting?
./scripts/dc.sh logs --no-log-prefix --since 15m caddy | jq -c 'select(.status==502 or .level=="error") | {ts, msg, error: .error?}'
./scripts/dc.sh exec caddy wget -qO- http://app_blue:3000/api/health   # direct, bypassing the proxy
docker inspect -f '{{.State.OOMKilled}} {{.RestartCount}} {{.State.ExitCode}}' $(docker ps -aqf label=com.docker.compose.service=app_blue)
```

**Probable causes.**
- The live color is stopped or crash-looping (bad env var, OOM kill: `OOMKilled=true`, exit 137).
- `upstream.caddy` points at a color that is not running (a manual `dc.sh stop` on the live color,
  or a hand-edited file).
- The app is up but `/api/health` fails because the database is down (then the app answers 503,
  not 502; see section 3).
- Every request gets `503 maintenance: restore in progress`: a `restore.sh` was interrupted and
  `upstream.caddy` still starts with `MAINTENANCE`. Check that no restore is still running,
  then `./scripts/deploy.sh --repoint`.

**Fix.** If a deploy just happened: `./scripts/deploy.sh --rollback`. If the live color is
stopped: `./scripts/dc.sh start app_<color>`. OOM: raise the server's memory or add a
`mem_limit` with headroom and look for the request that spikes memory. Wrong upstream: re-run
`./scripts/deploy.sh` with the image in `state.env`, which rewrites the file consistently; do not
hand-edit it.

## 2. Delivery queue stopped (events accepted, nothing delivered)

**Symptoms.** Ingest answers 202, the dashboard shows deliveries stuck in `pending` with
`next_attempt_at` in the past; monitor fires `queue` ("overdue ... is the scheduler running?").

**Investigate.**

```bash
./scripts/dc.sh ps -a scheduler
./scripts/dc.sh logs --no-log-prefix --since 30m scheduler      # tick_failed with status=401? 502? timeouts?
./scripts/dc.sh exec postgres psql -U relay relay -c \
  "select status, count(*), min(next_attempt_at) from deliveries group by 1;"
./scripts/dc.sh exec postgres psql -U relay relay -c \
  "select count(*) from deliveries where status='processing' and locked_at < now() - interval '5 minutes';"
```

**Probable causes.**
- Scheduler container stopped (someone ran `dc.sh stop scheduler`), or the proxy is still in
  maintenance after an interrupted restore (section 1): the scheduler goes through it.
- `scheduler.tick_failed status=401`: `CRON_SECRET` differs between the scheduler and the app
  (changed `.env` but only one side was recreated).
- `status=502/000`: the scheduler goes through Caddy's internal listener, so a proxy/app problem
  (section 1) also stops the queue.
- Rows stuck in `processing`: a worker died mid-attempt. They are reclaimed automatically after
  5 minutes (`STALE_LOCK_MS`); many of them point at app crashes during delivery.

**Fix.** Start or recreate the scheduler (`./scripts/dc.sh up -d scheduler`). After changing
secrets, recreate both sides: `./scripts/deploy.sh --build <tag>` (app) and
`./scripts/dc.sh up -d scheduler`. Verify the overdue count drops to 0. Deliveries that exhausted
their attempts meanwhile are in the dead-letter queue: replay them from the dashboard or
`POST /api/v1/events/<id>/replay`.

## 3. Postgres refuses connections / runs out of connections

**Symptoms.** `/api/health` returns 503 `{"ok":false}`; app logs show `db.init_failed`,
`ECONNREFUSED`, `too many clients already` or `remaining connection slots are reserved`; monitor
fires `database` and `health`.

**Investigate.**

```bash
./scripts/dc.sh ps -a postgres
./scripts/dc.sh logs --since 30m postgres | tail -50          # FATAL, PANIC, "No space left on device"
./scripts/dc.sh exec postgres psql -U relay relay -c \
  "select application_name, state, count(*) from pg_stat_activity group by 1,2 order by 3 desc;"
./scripts/dc.sh exec postgres psql -U relay relay -c \
  "select pid, now()-query_start as age, state, left(query,80) from pg_stat_activity where state <> 'idle' order by 2 desc limit 10;"
```

**Probable causes.**
- Postgres is down: usually a full disk (section 4) or a crash after OOM.
- Connection exhaustion: each app process opens a pool of up to 5 connections; both colors during a
  deploy, plus monitor/backup/psql sessions, must fit in `POSTGRES_MAX_CONNECTIONS` (50). Many
  `idle in transaction` rows mean a code path holds transactions open.
- A long query or lock (`state = active` for minutes, `wait_event_type = Lock`).

**Fix.** Disk: section 4, then `./scripts/dc.sh up -d postgres`. Exhaustion: terminate the
offenders (`select pg_terminate_backend(pid) ...`), then find who opened them
(`application_name`, `client_addr`) before raising `POSTGRES_MAX_CONNECTIONS`; raising the limit
without a cause just moves the wall.

## 4. Disk full

**Symptoms.** Monitor fires `disk`; Postgres logs `No space left on device` and may stop; backups
fail (`backup.failed`); Docker cannot pull or build.

**Investigate.**

```bash
df -h /
docker system df                                   # images, build cache, volumes
du -sh deploy/backups; ls -lt deploy/backups | head
sudo du -xh /var/lib/docker --max-depth=2 | sort -h | tail -15
./scripts/dc.sh exec postgres psql -U relay relay -c \
  "select relname, pg_size_pretty(pg_total_relation_size(relid)) from pg_statio_user_tables order by pg_total_relation_size(relid) desc limit 5;"
```

**Probable causes.**
- Old images and build cache from many `--build` deploys (each release adds an image).
- Backups: `BACKUP_KEEP` too high for the disk, or something else writes into `deploy/backups`.
- Database growth: `events` keeps every payload (raw body + JSON); the sandbox prunes, a real
  database does not.
- Logs outside Docker's rotation (all compose services rotate at 10 MB × 5).

**Fix.** `docker image prune -a --filter "until=168h"` and `docker builder prune` (keeps what the
running containers use); lower `BACKUP_KEEP` after copying older dumps off-site; for the database,
add a retention job for old delivered events and run `VACUUM (ANALYZE)`. Verify with `df -h` and
check that the monitor sends `resolved`.

## 5. Certificate not issued

**Symptoms.** Browser shows a certificate error or `ERR_SSL_PROTOCOL_ERROR`; `curl -v
https://DOMAIN` fails in the TLS handshake; HTTP works or redirects.

**Investigate.**

```bash
dig +short DOMAIN                                  # must be this server's public IP
curl -sI http://DOMAIN/ | head -3                  # reachable on :80 from outside? (run from your laptop)
./scripts/dc.sh logs --no-log-prefix --since 1h caddy | jq -c 'select(.logger | test("tls|acme")?) | {ts, level, msg, error: .error?}'
sudo ufw status
echo | openssl s_client -connect DOMAIN:443 -servername DOMAIN 2>/dev/null | openssl x509 -noout -issuer -dates
```

**Probable causes.**
- DNS does not point at the server yet (or an old `AAAA` record points elsewhere: Let's Encrypt
  prefers IPv6 when it exists).
- Port 80 or 443 blocked (ufw, cloud provider firewall/security group): the HTTP-01 and TLS-ALPN
  challenges need them.
- Rate limits after many failed attempts (`too many failed authorizations`, `rateLimited`).
- `CADDY_TLS=internal` left over from testing: the certificate is from "Caddy Local Authority".
- The `caddy_data` volume was deleted: certificates are re-issued on boot (and count against rate
  limits).

**Fix.** Fix DNS or firewall, then `./scripts/dc.sh restart caddy` and watch the logs for
`certificate obtained successfully`. On rate limits, wait (Caddy also falls back to ZeroSSL) and
never delete `caddy_data` as a "fix".

## 6. A deploy never becomes healthy

**Symptoms.** `deploy.sh` ends with `ROLLBACK: app_<color> exited during startup` /
`... is unhealthy` / `not healthy after 120s`. Users are not affected: the proxy was not switched.

**Investigate.** `deploy.sh` prints the last 40 log lines of the failed container. More:

```bash
./scripts/dc.sh logs --no-log-prefix app_green | tail -100
docker inspect -f '{{json .State.Health}}' $(docker ps -aqf label=com.docker.compose.service=app_green) | jq
./scripts/dc.sh run --rm -T migrate                # do migrations apply cleanly?
docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' $(docker ps -aqf label=com.docker.compose.service=app_green) \
  | sed -E 's/(PASSWORD|TOKEN|SECRET|DATABASE_URL)=.*/\1=***/'   # env it received, secrets masked
```

**Probable causes.**
- The new release crashes on boot (missing env var, code error at import time): the log shows a
  stack trace and exit code 1.
- Health fails because the app cannot reach Postgres with the new configuration (503 in the
  health log).
- The machine is too small to start a second instance next to the live one (OOM during startup,
  exit 137), or startup takes longer than `HEALTH_TIMEOUT_SECONDS`.
- The migration step failed: the script stopped before starting the new color.

**Fix.** Fix the release and deploy again; the live color keeps serving meanwhile. For slow
starts raise `HEALTH_TIMEOUT_SECONDS`; for memory, add RAM or swap rather than skipping
blue-green. CI runs exactly this scenario (a release that crashes on boot) on every PR.
