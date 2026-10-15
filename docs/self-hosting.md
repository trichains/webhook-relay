# Self-hosting webhook-relay (Docker)

[Português](self-hosting.pt-BR.md) · [Runbook](runbook.md)

webhook-relay runs on Vercel out of the box. This kit runs it on one Linux server you control
instead, with HTTPS, blue-green deploys without downtime, scheduled backups, alerts and a
diagnostic script. The whole flow (deploy, zero-downtime switch, rollback of a broken release,
backup/restore, outage alert) runs on every pull request in
[`.github/workflows/selfhost.yml`](../.github/workflows/selfhost.yml), on a GitHub runner
with Caddy's internal CA. Treat it as a tested kit, not as a managed service: you still own the
server, its updates and the off-site copy of your backups.

## What runs

```
                    :80 / :443 (HTTP/1.1, HTTP/2, HTTP/3)
 webhook senders ──▶ caddy ──▶ app_blue  ─┐   (one color live,
                       │   └─▶ app_green ─┤    the other idle)
                       │ :8080 (internal) ├──▶ postgres (volume pgdata)
     scheduler ────────┤                  │
     monitor ──────────┘  ─ alerts ─▶ ALERT_WEBHOOK_URL
     backup  ── pg_dump ─▶ deploy/backups/*.dump
```

| service | what it does |
|---|---|
| `postgres` | Postgres 17, data in the `pgdata` volume, not published on the host |
| `migrate` | one-shot job: drizzle migrations under an advisory lock, run by `deploy.sh` before each release |
| `app_blue`, `app_green` | the app image (Next.js standalone, non-root, `HEALTHCHECK` on `/api/health`). Only one is live |
| `caddy` | reverse proxy, automatic HTTPS (Let's Encrypt/ZeroSSL) or `tls internal`, HTTP→HTTPS redirect, HSTS, JSON access log |
| `scheduler` | calls `/api/cron/deliver` every `SCHEDULER_INTERVAL_SECONDS` (replaces Vercel Cron) |
| `backup` | `pg_dump` every `BACKUP_INTERVAL_SECONDS`, verified, checksummed, keeps the newest `BACKUP_KEEP` |
| `monitor` | checks health, database, queue, disk and backup age; debounced alerts to a webhook |

Every container logs to Docker's `json-file` driver with rotation (10 MB × 5 files per container),
so logs cannot fill the disk.

## Requirements

- A Linux VPS (Ubuntu 24.04 or Debian 12 tested in spirit; CI runs Ubuntu 24.04). 1 vCPU / 1 GB RAM
  is enough for small volumes; 2 GB is comfortable while building the image on the server.
- Docker Engine 25+ with the Compose plugin (`docker compose version` ≥ 2.24).
- A domain (or subdomain) you can point at the server.
- Ports 80 and 443 reachable from the internet (Let's Encrypt validates over them).

## 1. Prepare the server

```bash
# Docker (official convenience script; read it first if you prefer: https://get.docker.com)
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"   # log out and back in

# Firewall: SSH, HTTP, HTTPS only. Allow SSH *before* enabling ufw.
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp            # HTTP/3 (optional)
sudo ufw enable
```

> Docker publishes ports through its own iptables rules, which bypass ufw. This stack only
> publishes 80/443 (Caddy); Postgres and the apps are reachable only on the internal Docker
> network. Do not add `ports:` to `postgres` without understanding that.

## 2. DNS

Create an `A` record (and `AAAA` if the server has IPv6) for your domain pointing at the server,
for example `relay.example.com → 203.0.113.10`. Wait until `dig +short relay.example.com`
returns the server's address before the first deploy; otherwise the certificate cannot be issued
(see [runbook: certificate not issued](runbook.md#5-certificate-not-issued)).

## 3. Configure

```bash
git clone https://github.com/trichains/webhook-relay.git
cd webhook-relay/deploy
cp .env.example .env
chmod 600 .env
```

Edit `deploy/.env`:

| variable | value |
|---|---|
| `DOMAIN` | `relay.example.com` |
| `CADDY_TLS` | your e-mail (ACME account for Let's Encrypt), or `internal` for a private CA |
| `POSTGRES_PASSWORD`, `RELAY_ADMIN_TOKEN`, `CRON_SECRET` | `openssl rand -hex 32` each (hex only: the password goes into a URL) |
| `ALERT_WEBHOOK_URL` | Discord webhook URL, a Slack-compatible hook, or `https://ntfy.sh/<topic>` with `ALERT_FORMAT=text` |

The other variables have sensible defaults and are documented in the file. `deploy/.env` is
gitignored; never commit it.

## 4. First deploy

```bash
./scripts/deploy.sh --build v1
```

This builds the image from your checkout (`webhook-relay:v1` plus `webhook-relay-migrate:v1`),
starts Postgres and Caddy, runs the migrations, starts `app_blue`, waits until it is healthy,
points Caddy at it and starts the scheduler, backup and monitor services. Then:

```bash
curl https://relay.example.com/api/health
# {"ok":true,"driver":"pg","version":"v1"}
```

The dashboard is at `https://relay.example.com/dashboard` (HTTP Basic auth, any username, password
= `RELAY_ADMIN_TOKEN`). Create a source there and point your platform's webhooks at the ingest URL
it shows.

## 5. Deploying a new version (zero downtime)

```bash
git pull
./scripts/deploy.sh --build v2          # or: --image ghcr.io/<you>/webhook-relay:v2
```

What `deploy.sh` does, in order:

1. Takes a lock (one deploy at a time) and resolves the image (build, pull or `--rollback`).
2. Runs the migrations job. If it fails, nothing else happens and the live color keeps serving.
3. Starts the idle color with the new image and waits for its Docker health check
   (`HEALTH_TIMEOUT_SECONDS`, default 120). If the container exits, restarts or reports unhealthy,
   it is removed and the script exits non-zero: **automatic rollback**, the proxy never switched.
4. Probes the new color from inside the Caddy container (same network path the proxy will use).
5. Rewrites `runtime/caddy/upstream.caddy` and runs `caddy reload`, a graceful config swap:
   in-flight requests finish on the old color, new requests go to the new one.
6. Checks `/api/health` 5 times through the proxy; on failure it points Caddy back.
7. Waits `DRAIN_SECONDS` (15), then stops the old color with `SIGTERM` and a 30 s grace period.
   `init: true` makes sure the signal reaches Node, so in-flight requests and `after()` callbacks
   (first delivery attempts) finish.

CI measures this on every PR with continuous HTTPS traffic during the deploy and fails on any
error or timeout; see the job summary of the "Self-hosting" workflow.

Roll back to the previous image (no migrations are run):

```bash
./scripts/deploy.sh --rollback
```

**Migrations and rollback.** Both colors talk to the same database, and the migration runs before
the switch, so the old version briefly runs against the new schema. Keep migrations
backward-compatible (expand, deploy, then contract in a later release) and rollback stays safe.

**Several app instances.** Blue and green are separate builds, so a dashboard form rendered by the
old version and submitted after the switch can fail with "Failed to find Server Action"; reload
the page. Setting `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` at build time keeps the key stable across
builds. Webhook ingest and the API are plain route handlers and are not affected.

## 6. Backups

The `backup` service writes `deploy/backups/<db>-<UTC timestamp>.dump` (pg_dump custom format)
plus a `.sha256`, verifies each dump is readable before keeping it, and deletes all but the newest
`BACKUP_KEEP` dumps. The monitor alerts when the newest dump is older than
`BACKUP_MAX_AGE_SECONDS`.

```bash
./scripts/backup.sh                                     # backup now, prints the file
./scripts/restore.sh backups/relay-20261015T030000Z.dump  # asks for confirmation
```

`restore.sh` verifies the checksum, takes a safety backup of the current state, pauses the
scheduler, restores in a single transaction (all or nothing) and resumes the scheduler.

### Off-site backups

A backup on the same disk does not survive losing the server. Copy `deploy/backups` somewhere else,
for example with [rclone](https://rclone.org) to any S3-compatible bucket, from the host's crontab:

```cron
# 03:30 every day: mirror new dumps to the bucket (never deletes remote files)
30 3 * * * rclone copy /home/deploy/webhook-relay/deploy/backups remote:relay-backups --include "*.dump*"
```

Test a restore from the off-site copy once in a while: copy a dump back into `deploy/backups` and
run `restore.sh` on a staging server. A backup you never restored is a hope, not a backup.

## 7. Logs

Apps, Caddy and the ops containers all log one JSON object per line.

```bash
./scripts/dc.sh logs -f --since 10m app_blue app_green          # live app logs
./scripts/dc.sh logs --no-log-prefix --since 1h app_green \
  | jq -c 'select(.level == "error")'                           # errors only
./scripts/dc.sh logs --no-log-prefix --since 1h caddy \
  | jq -c 'select(.status >= 500) | {ts, status, uri: .request.uri, upstream: .upstream_addr?}'
./scripts/dc.sh logs --no-log-prefix --since 1h app_green \
  | jq -r 'select(.event == "ingest.accepted") | .source' | sort | uniq -c   # webhooks per source
```

`dc.sh` is `docker compose` with this stack's files, env and deploy state; it also sees the
`app_blue`/`app_green` profiles, which a bare `docker compose ps` would hide.

## 8. Alerts

The monitor runs every `MONITOR_INTERVAL_SECONDS` and checks:

| check | fires when |
|---|---|
| `health` | `/api/health` through the proxy is not 200 / `ok:true` |
| `database` | the monitor cannot query Postgres |
| `queue` | a due delivery waited more than `QUEUE_STUCK_SECONDS` (worker not running) or more than `QUEUE_MAX_PENDING` are queued |
| `disk` | the host filesystem holding `deploy/backups` is over `DISK_MAX_PERCENT` |
| `backup` | the newest dump is older than `BACKUP_MAX_AGE_SECONDS` (or there is none) |

A check alerts after `MONITOR_FAILURES_BEFORE_ALERT` consecutive failures, repeats at most every
`ALERT_REPEAT_SECONDS` while still failing, and sends one `resolved` when it recovers. Payload
(`ALERT_FORMAT=json`):

```json
{"content":"[webhook-relay-prod] FIRING health: GET http://caddy:8080/api/health -> status=502 ...",
 "text":"...same...","status":"firing","check":"health","message":"...","instance":"webhook-relay-prod","ts":"2026-10-15T21:10:03Z"}
```

Discord reads `content`, Slack-style hooks read `text`, your own receiver gets the structured
fields. For ntfy set `ALERT_FORMAT=text` and `ALERT_WEBHOOK_URL=https://ntfy.sh/<topic>`.
To test the path end to end, stop the live app for a minute:
`./scripts/dc.sh stop app_blue`, wait for the alert, `./scripts/dc.sh start app_blue`.

## 9. When something breaks

```bash
./scripts/diagnose.sh            # containers, health, recent errors, Postgres connections,
SINCE=2h ./scripts/diagnose.sh   # queue, disk, backups: read-only
```

Then follow the [runbook](runbook.md).

## Reference

- Image: `Dockerfile` (targets `runner`, default, and `migrator`). Built with
  `NEXT_OUTPUT=standalone`; Vercel builds do not set it and are unchanged.
- `RELAY_INTERNAL_URL=http://127.0.0.1:3000` (set by the compose file): deliveries to the built-in
  `/api/sink/*` receivers stay inside the container instead of going out through the domain.
- Runtime state: `deploy/runtime/state.env` (live color, images, previous image) and
  `deploy/runtime/caddy/upstream.caddy`. Both are gitignored and owned by `deploy.sh`.
- Limitations: one server, one Postgres (no replica, no PITR: the recovery point is the last dump);
  the build runs on the server unless you publish images to a registry; no metrics stack
  (Prometheus/Grafana), only checks and alerts.
