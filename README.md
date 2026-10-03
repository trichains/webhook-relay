# Webhook Relay

[English](README.md) · [Português](README.pt-BR.md)

A webhook gateway for payment and sales platforms. It verifies signatures, deduplicates events, retries failed deliveries with exponential backoff, keeps a searchable audit log and lets you replay anything from a dead-letter queue. Next.js app with a dashboard and a small management API.

[![CI](https://github.com/trichains/webhook-relay/actions/workflows/ci.yml/badge.svg)](https://github.com/trichains/webhook-relay/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Demo](https://img.shields.io/badge/demo-live-f2884b.svg)](https://webhook-relay-gray.vercel.app)

![banner](docs/banner.png)

## Why

Platforms like Hotmart, Stripe-style payment processors and CRMs tell your systems about sales through webhooks. Handling them directly inside each app tends to go wrong in the same few ways:

- **Forged requests.** Without signature checks, anyone who finds the URL can "approve" a purchase.
- **Duplicates.** Senders retry on timeouts, so the same `PURCHASE_APPROVED` can arrive two or three times. Without idempotency you grant access twice, send two emails, or count revenue twice.
- **Downstream outages.** If the member area or the ERP is down for ten minutes, events sent in that window are lost unless something keeps retrying.
- **No trail.** When a customer says "I paid and got nothing", you need to see exactly what arrived, when, and what your receiver answered.

Webhook Relay sits between the platform and your apps and handles those four problems in one place. Your apps receive a verified, deduplicated stream with an `Idempotency-Key` header, and you get a dashboard to see and replay what happened.

## What it does

- **Sources (inbound).** Each source gets an ingest URL `POST /api/ingest/<slug>` and a secret generated on the server and shown once. Signing schemes:
  - `hmac-sha256`: `X-Signature: t=<unix>,v1=<hex HMAC of "<t>.<raw body>">`, 5 minute timestamp tolerance, constant-time compare.
  - `hotmart-hottok`: static token in `X-HOTMART-HOTTOK` (or `?hottok=` for Hotmart v1), constant-time compare.
  - `none`: accepts anything; flagged in red in the UI and not available in the public sandbox.
- **Secret rotation with a grace period.** Rotating a secret keeps the previous one valid for 24 hours, so you can update the sender without dropping events. The UI shows until when the old secret is accepted and lets you revoke it early; events verified with it are labelled as such.
- **Ingestion.** Reads the raw body (1 MB limit), verifies, parses JSON, derives an idempotency key (`Idempotency-Key` header, else the payload `id`, else `sha256(source + body)`), extracts the event type from a configurable JSON path (`event` by default), stores the event and answers `202`. Duplicates get `200 {"duplicate": true}` and are not delivered again. Requests that fail verification get `401` and are stored for audit but never delivered.
- **Destinations (outbound).** Per source: URL, optional event filter (comma-separated types), active toggle, max attempts (default 6) and HTTP timeout. The original payload is forwarded byte for byte with `Idempotency-Key`, `X-Relay-Event-Id`, `X-Relay-Delivery-Id`, `X-Relay-Attempt` and `X-Relay-Event-Type` headers.
- **Built-in demo sinks** so the demo works without external URLs: `/api/sink/ok` (200), `/api/sink/fail` (500), `/api/sink/flaky` (503 about half the time), `/api/sink/slow` (200 after 3 s), `/api/sink/reject` (400).
- **Delivery engine.** The first attempt runs right after the `202` with `after()` from `next/server`. Each attempt records status code, latency, the first 500 characters of the response and the error. Failures are retried with exponential backoff and jitter; after max attempts, or on a permanent 4xx or a redirect (redirects are never followed), the delivery goes to the dead-letter queue.
- **Outbound URL policy.** In the sandbox only the built-in sinks are allowed, checked when a destination is saved and again right before every attempt. With a real database, external URLs are allowed but hosts in private, loopback, link-local, CGNAT and other reserved ranges are refused, both as literal hosts (including IPv4-mapped IPv6, `::`, trailing-dot names and decimal/hex IPv4) and after resolving the hostname, before each attempt.
- **Queue worker.** `GET /api/cron/deliver` (Vercel Cron, protected by `CRON_SECRET`) and a "Process queue now" button. Safe to run concurrently: rows are claimed with `FOR UPDATE SKIP LOCKED` on Postgres.
- **Replay.** Replay one event to one destination (or to all matching destinations), or move all dead letters of a destination back to the queue.
- **Dashboard** (`/dashboard`): 24h overview (events, delivery success rate, dead letters, p50/p95 latency, hourly volume), events table with filters (source, status, event type, idempotency key search), event detail (headers, pretty JSON with copy, verification result, attempt timeline per destination), destination health, dead-letter queue, and source/destination CRUD through Server Actions with zod validation.
- **Send test webhook.** Signs a realistic sample (Hotmart `PURCHASE_APPROVED` v2-style payload for hottok sources, a generic `order.paid` otherwise) with the source's own secret, sends it through the ingest pipeline and links to the created event.
- **Management API** under `/api/v1` (see below).
- **Sandbox mode.** Without `DATABASE_URL`, an in-memory PGlite database is migrated and seeded at boot with 2 sources, 4 destinations on the demo sinks and 60 events over the last 48 hours with mixed outcomes. The first request after a cold start takes about 3 s locally (WASM Postgres boot, migrations and seed), more on Vercel.

## Architecture

```mermaid
sequenceDiagram
    autonumber
    participant P as Platform (Hotmart, checkout, CRM)
    participant I as POST /api/ingest/[slug]
    participant DB as Postgres / PGlite
    participant W as Delivery engine
    participant D as Destination
    participant U as Dashboard / API

    P->>I: webhook (raw body + signature)
    I->>I: verify HMAC or hottok (constant time)
    alt invalid signature
        I->>DB: store as rejected (audit only)
        I-->>P: 401
    else valid
        I->>I: parse JSON, derive idempotency key, event type
        I->>DB: insert event (unique per source + key)
        alt duplicate key
            I-->>P: 200 {duplicate: true}
        else new event
            I->>DB: one delivery row per matching active destination
            I-->>P: 202 accepted
            Note over I,W: after(): first attempt runs once the response is sent
            W->>DB: claim delivery (status pending → processing)
            W->>W: check URL policy (sinks only in sandbox, resolved IP not private)
            W->>D: POST original payload + Idempotency-Key
            alt 2xx
                W->>DB: attempt ok, delivery succeeded
            else error, timeout or 5xx/408/429
                W->>DB: attempt failed, next_attempt_at = now + backoff
                loop cron (daily on Hobby, every minute on Pro) / "Process queue now"
                    W->>DB: claim due rows (FOR UPDATE SKIP LOCKED)
                    W->>D: retry
                end
                W->>DB: max attempts reached (or permanent 4xx / 3xx) → dead_letter
            end
        end
    end
    U->>DB: replay event / retry all dead letters → pending
    U->>W: attempt again (same attempt timeline, trigger = replay)
```

**Flow in words.** The ingest route does the minimum work needed to safely say "got it": verify, dedupe, persist, enqueue. Everything slow (calling your receivers) happens after the response, so a slow destination never makes the platform time out and retry. Deliveries are rows in Postgres with a status and a `next_attempt_at`, which makes the queue inspectable with plain SQL and lets any number of workers share it.

**Retry schedule** (`base 30s × 4^(n-1)`, capped at 6h, ±20% jitter):

| Failed attempt  | Production wait | Cumulative (no jitter) | Sandbox wait  |
| --------------- | --------------- | ---------------------- | ------------- |
| 1               | 30s             | 30s                    | 2s            |
| 2               | 2m              | 2m 30s                 | 4s            |
| 3               | 8m              | 10m 30s                | 8s            |
| 4               | 32m             | 42m 30s                | 16s           |
| 5               | 2h 8m           | 2h 50m 30s             | 32s           |
| 6 (default max) | → dead letter   |                        | → dead letter |
| 7+ (max 12)     | 6h (cap)        |                        | 60s (cap)     |

Sandbox mode compresses the schedule to seconds (base 2s, factor 2, cap 60s) so you can watch a delivery go from retrying to dead letter in under a minute. 4xx responses other than 408, 425 and 429 are treated as permanent and dead-lettered right away: the receiver understood the request and refused it, so sending the same bytes again will not help. 3xx responses are permanent too (`redirect not followed`), since following a redirect could send the payload somewhere the policy never checked.

The waits above are the earliest time a retry can happen; the actual time depends on how often the worker runs. `vercel.json` ships with a daily schedule (`0 0 * * *`) because Vercel Hobby rejects more frequent crons. On Vercel Pro, set it to `* * * * *` so retries follow the table closely.

**Folder structure**

```
app/
  api/ingest/[sourceSlug]/   inbound webhooks
  api/sink/[kind]/           built-in demo receivers
  api/cron/deliver/          queue worker (Vercel Cron)
  api/v1/events/             management API
  api/health/                liveness + driver
  dashboard/                 overview, events, sources, destinations, dead letters
    actions.ts               Server Actions (zod-validated)
  opengraph-image.tsx        generated Open Graph image
lib/
  db/schema.ts, client.ts    Drizzle schema, pg / PGlite handle (globalThis singleton)
  db/seed.ts                 deterministic sandbox fixture
  services/ingest.ts         verify → dedupe → store → enqueue
  services/delivery.ts       claim, attempt, backoff, dead-letter, queue pass
  services/replay.ts         replay and retry-all
  services/sources.ts        secret rotation, sandbox limits, event cap
  ssrf.ts                    outbound URL policy (literal + resolved IP checks)
  signing.ts, idempotency.ts, event-type.ts, backoff.ts, stats.ts
drizzle/                     generated SQL migrations
tests/unit, tests/integration, e2e/
proxy.ts                     Basic auth for /dashboard (fails closed with a real database and no token)
```

## Key decisions & trade-offs

- **Postgres as the queue.** No Redis or SQS: deliveries are rows, claimed with `UPDATE … WHERE id IN (SELECT … FOR UPDATE OF deliveries SKIP LOCKED)`. Cron, the "process now" button and `after()` can all run at the same time without double-sending. A row stuck in `processing` for more than 5 minutes (crashed worker) is reclaimed, and the lock timestamp works as an ownership token: the final write only succeeds if the row is still `processing` with the same `locked_at`, so a slow worker whose row was reclaimed cannot overwrite the result. On PGlite (single connection) the claim is a plain status transition. Throughput is fine for webhook volumes; a high-volume setup would want a dedicated queue.
- **At-least-once, with the key passed downstream.** A crash between the HTTP call and the database write can resend an attempt, so every outbound request carries `Idempotency-Key`. Exactly-once is not possible across an HTTP boundary; this is the honest version.
- **Idempotency key order: header → payload `id` → body hash.** Hotmart puts a unique `id` on every event, so retries of the same event dedupe even when the signature timestamp changes. The body hash is the fallback for senders that give you nothing. The unique index is partial (`WHERE verified`), so a forged request can never "burn" the key of a real event.
- **Rejected requests are kept, not delivered.** Helpful for debugging a misconfigured sender (wrong secret, clock skew). Stored bodies are truncated to 16 KB and secrets in headers are redacted.
- **Drizzle + one schema, two drivers.** `pg` when `DATABASE_URL` is set, PGlite (Postgres compiled to WASM) otherwise. Same SQL, same migrations. The integration tests run on PGlite by default (no Docker needed), and CI runs the same suite against a `postgres:16` service so the `SKIP LOCKED` path is exercised for real.
- **A public demo that cannot be abused.** In the sandbox, destinations can only point at the built-in sinks, the `none` scheme is disabled, the seeded demo sources are read-only (no delete, no secret rotation, their destinations cannot be deleted), events are capped at 2,000 (oldest dropped, rejected ones included) and there are limits of 25 sources and 10 destinations per source.
- **Configured base URL over the Host header.** Ingest URLs, sink resolution and "send test webhook" use `NEXT_PUBLIC_APP_URL`, then Vercel's production domain (`VERCEL_PROJECT_PRODUCTION_URL`), and only then the request origin, since the Host header is client-controlled.
- **Sandbox details for serverless.** The PGlite instance lives on `globalThis` so it survives across requests on a warm instance. "Send test webhook" calls the ingest pipeline in-process in sandbox mode (an HTTP call could land on a different instance with a different in-memory database); with a real database it is a real HTTP POST to the ingest URL. Dashboard page views also run a small queue pass in sandbox mode for the same reason.
- **Replays reset the delivery in place.** The attempt cycle goes back to zero and `replay_count` increments, so the full history (failed attempts, then the replay) stays on one timeline instead of being spread across copies.
- **Secrets stored in plain text.** HMAC verification needs the original secret, so it cannot be hashed. The UI shows it once on creation or rotation. Encrypting it at rest is on the roadmap.

## Stack

Next.js 16 (App Router, Server Actions, `after()`, `proxy.ts`), React 19, TypeScript (strict), Tailwind CSS v4, Drizzle ORM, `pg` / `@electric-sql/pglite`, zod 4, Vitest, Playwright.

## Running locally

Prerequisites: Node 22+ and npm.

```bash
npm install
cp .env.example .env.local   # optional, everything works with it empty
npm run dev                  # http://localhost:3101
```

With no `DATABASE_URL` the app starts in sandbox mode. To use Postgres:

```bash
DATABASE_URL=postgres://user:pass@localhost:5432/webhook_relay npm run db:migrate
DATABASE_URL=... RELAY_ADMIN_TOKEN=$(openssl rand -hex 32) npm run dev
```

| Variable              | Purpose                                                                                                                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`        | Postgres connection string. Empty = sandbox (PGlite in memory, seeded, resets on restart).                                                                                              |
| `RELAY_ADMIN_TOKEN`   | Bearer token for `/api/v1/*` and Basic auth password for `/dashboard`. Required with a real database: without it the API answers 503 and the dashboard answers 503 (fails closed).    |
| `CRON_SECRET`         | Vercel Cron sends it as a bearer token to `/api/cron/deliver`. Empty = endpoint open.                                                                                                   |
| `NEXT_PUBLIC_APP_URL` | Public base URL. Takes precedence over the request Host header for ingest URLs, built-in sink resolution, test webhooks and Open Graph metadata (fallback: `VERCEL_PROJECT_PRODUCTION_URL`). |

Sending a signed webhook by hand (HMAC source):

```bash
BODY='{"id":"evt_123","event":"order.paid"}'
TS=$(date +%s)
SIG=$(printf '%s' "$TS.$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')
curl -X POST http://localhost:3101/api/ingest/<your-source-slug> \
  -H 'content-type: application/json' -H "x-signature: t=$TS,v1=$SIG" -d "$BODY"
```

The seeded demo sources get random secrets at boot and are read-only in the sandbox; create your own source on `/dashboard/sources` to get a secret you can copy.

Tests:

```bash
npm run lint
npm run typecheck
npm test             # unit + integration on PGlite (no Docker needed)
DATABASE_URL=postgres://... npm test   # same suite against a real (disposable!) Postgres; it truncates the tables
npx playwright install chromium
npm run test:e2e     # starts or reuses the dev server on :3101
```

### Management API

All `/api/v1` endpoints require `Authorization: Bearer $RELAY_ADMIN_TOKEN` when the token is set. In sandbox mode without a token they are open and responses carry `x-relay-auth: open-sandbox`.

| Method | Path                         | Description                                                                                                                                                                                                                             |
| ------ | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/api/v1/events`             | List events. Query: `source` (id), `status` (`pending`, `delivered`, `dead_letter`, `rejected`, `no_destinations`), `type`, `q` (idempotency key contains), `page`, `page_size` (max 200). Returns `{ data, page, pageSize, total }`. |
| `GET`  | `/api/v1/events/{id}`        | Event with headers, payload, verification result and every delivery with its attempts.                                                                                                                                                  |
| `POST` | `/api/v1/events/{id}/replay` | Body `{ "destinationId"?: string }`. Re-queues the event (one destination, or all matching ones) and attempts right away. `202 { queued, deliveryIds }`. `409` for rejected events.                                                     |
| `POST` | `/api/ingest/{slug}`         | Ingest endpoint. `202` accepted, `200` duplicate, `401` bad signature, `400` invalid JSON, `404` unknown source, `413` over 1 MB.                                                                                                      |
| `GET`  | `/api/cron/deliver`          | One queue pass (up to 50 due deliveries). Bearer `CRON_SECRET` when set.                                                                                                                                                                |
| `GET`  | `/api/health`                | `{ ok, driver }`.                                                                                                                                                                                                                       |

## Demo & limitations

- The public demo runs in sandbox mode: data lives in memory and resets on every cold start. Different serverless instances can show different data.
- No user accounts. With `RELAY_ADMIN_TOKEN` set, the dashboard is behind HTTP Basic auth; in the sandbox (no token, no database) it is open, with the restrictions listed under key decisions.
- With the default daily cron, retries that are not triggered by `after()`, "Process queue now" or (in sandbox mode) dashboard page views wait for the next daily run. Use `* * * * *` on Vercel Pro.
- The private-address check resolves the hostname before each attempt, but `fetch` resolves it again when connecting. A DNS answer that changes between the two lookups (rebinding with a very short TTL) is not fully covered; pinning the connection to the checked IP is on the roadmap.
- Latency percentiles are computed in the app over the most recent 10,000 attempts of the window, which is fine at this scale but not for millions of rows.
- Outbound requests are not signed yet, so receivers cannot verify they came from the relay (beyond network controls).

## Roadmap

- Sign outbound deliveries (HMAC per destination) so receivers can verify the relay.
- Pin outbound connections to the IP that passed the private-address check.
- Encrypt source secrets at rest.
- Payload transforms per destination (field mapping, e.g. Hotmart → CRM format).
- Configurable retention for events and attempts with a real database, plus percentile queries in SQL.
- Per-destination rate limiting and a circuit breaker that pauses a destination after repeated failures.

## License

[MIT](LICENSE) © 2026 Cristhian Almeida
