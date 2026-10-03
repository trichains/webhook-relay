import { and, eq, inArray, lt, lte, or, sql } from "drizzle-orm";
import type { BackoffConfig } from "@/lib/backoff";
import { backoffDelayMs, PRODUCTION_BACKOFF, SANDBOX_BACKOFF } from "@/lib/backoff";
import type { Db, DbHandle } from "@/lib/db/client";
import {
  attempts,
  deliveries,
  destinations,
  events,
  type AttemptTrigger,
  type DeliveryStatus,
  type EventStatus,
} from "@/lib/db/schema";
import { env } from "@/lib/env";
import { log } from "@/lib/log";
import { checkOutboundUrl, type LookupFn, type UrlPolicy } from "@/lib/ssrf";
import { currentUrlPolicy } from "@/lib/validation";

export const RESPONSE_SNIPPET_LIMIT = 500;
/** A row stuck in `processing` longer than this is considered abandoned (crashed worker) and reclaimed. */
export const STALE_LOCK_MS = 5 * 60 * 1000;

export type EngineOptions = {
  /** Origin used to resolve relative destination URLs such as `/api/sink/ok`. */
  baseUrl: string;
  fetchImpl?: typeof fetch;
  backoff?: BackoffConfig;
  now?: () => Date;
  random?: () => number;
  /** Outbound URL policy; defaults to the environment (sandbox = built-in sinks only). */
  urlPolicy?: UrlPolicy;
  /** DNS resolver used for the private-address check (injectable for tests). */
  lookup?: LookupFn;
};

/** A row this worker owns: the lock timestamp it wrote is the ownership token. */
export type Claim = { id: string; lockedAt: Date };

export type AttemptOutcome = {
  deliveryId: string;
  ok: boolean;
  status: DeliveryStatus;
  statusCode: number | null;
  latencyMs: number;
  error: string | null;
};

export function defaultBackoff(): BackoffConfig {
  return env.isSandbox ? SANDBOX_BACKOFF : PRODUCTION_BACKOFF;
}

export function resolveTargetUrl(url: string, baseUrl: string): string {
  return url.startsWith("/") ? `${baseUrl.replace(/\/$/, "")}${url}` : url;
}

/**
 * 4xx responses mean the receiver understood the request and refused it; retrying the same
 * payload will not help. Exceptions: 408 (timeout), 425 (too early) and 429 (rate limited).
 */
export function isRetryableStatus(statusCode: number | null): boolean {
  if (statusCode === null) return true; // network error / timeout
  if (statusCode >= 300 && statusCode < 400) return false; // redirects are not followed
  if (statusCode >= 400 && statusCode < 500) return [408, 425, 429].includes(statusCode);
  return true;
}

/** Aggregates delivery statuses into the denormalized event status used for filtering. */
export function computeEventStatus(statuses: DeliveryStatus[]): EventStatus {
  if (statuses.length === 0) return "no_destinations";
  if (statuses.some((s) => s === "pending" || s === "processing")) return "pending";
  if (statuses.some((s) => s === "dead_letter")) return "dead_letter";
  return "delivered";
}

export async function refreshEventStatus(db: Db, eventId: string): Promise<EventStatus> {
  const rows = await db.select({ status: deliveries.status }).from(deliveries).where(eq(deliveries.eventId, eventId));
  const status = computeEventStatus(rows.map((r) => r.status));
  await db
    .update(events)
    .set({ status })
    .where(and(eq(events.id, eventId), sql`${events.status} <> 'rejected'`));
  return status;
}

type HttpResult = {
  ok: boolean;
  statusCode: number | null;
  latencyMs: number;
  snippet: string | null;
  error: string | null;
};

async function performHttp(
  url: string,
  init: { body: string; headers: Record<string, string>; timeoutMs: number },
  fetchImpl: typeof fetch,
): Promise<HttpResult> {
  const started = performance.now();
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      body: init.body,
      headers: init.headers,
      signal: AbortSignal.timeout(init.timeoutMs),
      redirect: "manual",
      cache: "no-store",
    });
    const text = await res.text().catch(() => "");
    const latencyMs = Math.round(performance.now() - started);
    const ok = res.status >= 200 && res.status < 300;
    const redirect = res.status >= 300 && res.status < 400;
    return {
      ok,
      statusCode: res.status,
      latencyMs,
      snippet: text.slice(0, RESPONSE_SNIPPET_LIMIT) || null,
      error: ok ? null : redirect ? `redirect not followed (HTTP ${res.status})` : `HTTP ${res.status}`,
    };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - started);
    const name = err instanceof Error ? err.name : "";
    const message =
      name === "TimeoutError" || name === "AbortError"
        ? `timeout after ${init.timeoutMs}ms`
        : err instanceof Error
          ? err.message
          : String(err);
    return { ok: false, statusCode: null, latencyMs, snippet: null, error: message.slice(0, RESPONSE_SNIPPET_LIMIT) };
  }
}

/**
 * Atomically moves one pending delivery to `processing`. Works the same on Postgres and
 * PGlite because a single UPDATE ... WHERE status = 'pending' is atomic.
 */
export async function claimDelivery(db: Db, deliveryId: string, now = new Date()): Promise<Claim | null> {
  const rows = await db
    .update(deliveries)
    .set({ status: "processing", lockedAt: now, updatedAt: now })
    .where(and(eq(deliveries.id, deliveryId), eq(deliveries.status, "pending")))
    .returning({ id: deliveries.id });
  return rows.length > 0 ? { id: deliveryId, lockedAt: now } : null;
}

/**
 * Claims up to `limit` due deliveries for this worker.
 * - Postgres: `FOR UPDATE OF deliveries SKIP LOCKED` so concurrent workers (cron + "process now" +
 *   after()) never pick the same row and never block each other.
 * - PGlite: single connection, statements run one at a time, so the status transition in the
 *   UPDATE is enough.
 * Rows stuck in `processing` for longer than STALE_LOCK_MS are reclaimed.
 */
export async function claimDueDeliveries(handle: DbHandle, limit: number, now = new Date()): Promise<Claim[]> {
  const { db } = handle;
  const staleBefore = new Date(now.getTime() - STALE_LOCK_MS);
  const due = db
    .select({ id: deliveries.id })
    .from(deliveries)
    .innerJoin(destinations, eq(destinations.id, deliveries.destinationId))
    .where(
      and(
        eq(destinations.active, true),
        or(
          and(eq(deliveries.status, "pending"), lte(deliveries.nextAttemptAt, now)),
          and(eq(deliveries.status, "processing"), lt(deliveries.lockedAt, staleBefore)),
        ),
      ),
    )
    .orderBy(deliveries.nextAttemptAt)
    .limit(limit);

  const candidates = handle.driver === "pg" ? due.for("update", { of: deliveries, skipLocked: true }) : due;

  const rows = await db
    .update(deliveries)
    .set({ status: "processing", lockedAt: now, updatedAt: now })
    .where(inArray(deliveries.id, candidates))
    .returning({ id: deliveries.id });
  return rows.map((r) => ({ id: r.id, lockedAt: now }));
}

/** Runs one HTTP attempt for a delivery that this worker has already claimed. */
export async function attemptClaimedDelivery(db: Db, claim: Claim, opts: EngineOptions): Promise<AttemptOutcome | null> {
  const deliveryId = claim.id;
  const now = opts.now ?? (() => new Date());
  const fetchImpl = opts.fetchImpl ?? fetch;
  const backoff = opts.backoff ?? defaultBackoff();

  const [row] = await db
    .select({ delivery: deliveries, destination: destinations, event: events })
    .from(deliveries)
    .innerJoin(destinations, eq(destinations.id, deliveries.destinationId))
    .innerJoin(events, eq(events.id, deliveries.eventId))
    .where(eq(deliveries.id, deliveryId));
  if (!row) return null;
  const { delivery, destination, event } = row;

  const [{ count: previous }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(attempts)
    .where(eq(attempts.deliveryId, deliveryId));
  const attemptNumber = previous + 1;
  const trigger: AttemptTrigger =
    delivery.attemptCount > 0 ? "retry" : delivery.replayCount > 0 ? "replay" : "initial";

  const targetUrl = resolveTargetUrl(destination.url, opts.baseUrl);
  const startedAt = now();
  // Policy check right before the request: the stored URL may predate a policy change, and in
  // real mode the hostname is resolved and every address checked against private ranges.
  const block = await checkOutboundUrl(destination.url, opts.urlPolicy ?? currentUrlPolicy(), opts.lookup);
  const result: HttpResult = block
    ? { ok: false, statusCode: null, latencyMs: 0, snippet: null, error: block.error }
    : await performHttp(
    targetUrl,
    {
      // The original payload is forwarded byte-for-byte.
      body: event.rawBody,
      headers: {
        "content-type": "application/json",
        "user-agent": "webhook-relay/0.1",
        "idempotency-key": event.idempotencyKey,
        "x-relay-event-id": event.id,
        "x-relay-delivery-id": delivery.id,
        "x-relay-attempt": String(attemptNumber),
        ...(event.eventType ? { "x-relay-event-type": event.eventType } : {}),
      },
      timeoutMs: destination.timeoutMs,
    },
    fetchImpl,
  );

  const cycleAttempts = delivery.attemptCount + 1;
  let status: DeliveryStatus;
  let nextAttemptAt = delivery.nextAttemptAt;
  if (result.ok) {
    status = "succeeded";
  } else if (block?.permanent || !isRetryableStatus(result.statusCode) || cycleAttempts >= destination.maxAttempts) {
    status = "dead_letter";
  } else {
    status = "pending";
    nextAttemptAt = new Date(now().getTime() + backoffDelayMs(cycleAttempts, backoff, opts.random));
  }

  // Guarded write: only the worker that still owns the lock may record the outcome. If the row
  // was reclaimed as stale by another worker meanwhile, this attempt is dropped (logged only).
  const owned = await db
    .update(deliveries)
    .set({
      status,
      attemptCount: cycleAttempts,
      nextAttemptAt,
      lockedAt: null,
      lastStatusCode: result.statusCode,
      lastError: result.error,
      updatedAt: now(),
    })
    .where(and(eq(deliveries.id, deliveryId), eq(deliveries.status, "processing"), eq(deliveries.lockedAt, claim.lockedAt)))
    .returning({ id: deliveries.id });
  if (owned.length === 0) {
    log("warn", "delivery.lock_lost", { deliveryId, attempt: attemptNumber, statusCode: result.statusCode });
    return null;
  }

  await db.insert(attempts).values({
    deliveryId,
    attemptNumber,
    trigger,
    ok: result.ok,
    statusCode: result.statusCode,
    latencyMs: result.latencyMs,
    responseSnippet: result.snippet,
    error: result.error,
    startedAt,
  });
  await refreshEventStatus(db, event.id);

  log(result.ok ? "info" : "warn", "delivery.attempt", {
    deliveryId,
    eventId: event.id,
    destinationId: destination.id,
    attempt: attemptNumber,
    trigger,
    statusCode: result.statusCode,
    latencyMs: result.latencyMs,
    outcome: status,
    error: result.error,
  });

  return {
    deliveryId,
    ok: result.ok,
    status,
    statusCode: result.statusCode,
    latencyMs: result.latencyMs,
    error: result.error,
  };
}

async function runWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    results.push(...(await Promise.all(items.slice(i, i + concurrency).map(fn))));
  }
  return results;
}

export type ProcessSummary = {
  claimed: number;
  succeeded: number;
  retrying: number;
  deadLettered: number;
};

function summarize(outcomes: (AttemptOutcome | null)[], claimed: number): ProcessSummary {
  const done = outcomes.filter((o): o is AttemptOutcome => o !== null);
  return {
    claimed,
    succeeded: done.filter((o) => o.status === "succeeded").length,
    retrying: done.filter((o) => o.status === "pending").length,
    deadLettered: done.filter((o) => o.status === "dead_letter").length,
  };
}

/** Claims and attempts specific deliveries right away (used after ingest and replay). */
export async function deliverNow(handle: DbHandle, deliveryIds: string[], opts: EngineOptions): Promise<ProcessSummary> {
  const claimed: Claim[] = [];
  for (const id of deliveryIds) {
    const claim = await claimDelivery(handle.db, id, opts.now?.() ?? new Date());
    if (claim) claimed.push(claim);
  }
  const outcomes = await runWithConcurrency(claimed, 5, (claim) => attemptClaimedDelivery(handle.db, claim, opts));
  return summarize(outcomes, claimed.length);
}

/** One pass of the queue worker: claim due deliveries and attempt them. Safe to run concurrently. */
export async function processQueue(
  handle: DbHandle,
  opts: EngineOptions & { limit?: number },
): Promise<ProcessSummary> {
  const ids = await claimDueDeliveries(handle, opts.limit ?? 25, opts.now?.() ?? new Date());
  const outcomes = await runWithConcurrency(ids, 5, (claim) => attemptClaimedDelivery(handle.db, claim, opts));
  const summary = summarize(outcomes, ids.length);
  if (ids.length > 0) log("info", "queue.processed", summary);
  return summary;
}
