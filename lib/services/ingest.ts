import { and, eq } from "drizzle-orm";
import type { DbHandle } from "@/lib/db/client";
import { deliveries, destinations, events, sources } from "@/lib/db/schema";
import { extractEventType, matchesFilter } from "@/lib/event-type";
import { deriveIdempotencyKey } from "@/lib/idempotency";
import { env } from "@/lib/env";
import { log } from "@/lib/log";
import { pruneEvents, SANDBOX_LIMITS } from "@/lib/services/sources";
import { activeSecrets, HOTTOK_HEADER, verifyRequest } from "@/lib/signing";

export const MAX_BODY_BYTES = 1024 * 1024; // 1 MB
/** Rejected (unverified) requests are kept for audit, truncated to this size. */
export const MAX_REJECTED_BODY_CHARS = 16 * 1024;

const STORED_HEADERS = [
  "content-type",
  "content-length",
  "user-agent",
  "idempotency-key",
  "x-signature",
  HOTTOK_HEADER,
  "x-request-id",
  "x-forwarded-for",
  "x-hotmart-webhook-version",
];

export type IngestResult = {
  httpStatus: number;
  body: Record<string, unknown>;
  eventId?: string;
  deliveryIds: string[];
};

function redact(value: string): string {
  return value.length <= 4 ? "****" : `${value.slice(0, 4)}…(redacted)`;
}

export function selectHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of STORED_HEADERS) {
    const value = headers.get(name);
    if (value === null) continue;
    out[name] = name === HOTTOK_HEADER ? redact(value) : value.slice(0, 500);
  }
  return out;
}

function tryParseJson(raw: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

/**
 * Ingest pipeline: resolve source → read raw body → verify signature → parse JSON →
 * derive idempotency key → store event (+ one delivery row per matching active destination).
 * The caller is responsible for kicking off the first delivery attempt (after the response).
 */
export async function ingestWebhook(
  handle: DbHandle,
  params: {
    sourceSlug: string;
    request: Request;
    requestId?: string;
    now?: number;
    /** Keep at most this many events (oldest dropped). Defaults to a cap in sandbox mode only. */
    maxStoredEvents?: number;
  },
): Promise<IngestResult> {
  const { db } = handle;
  const { request, sourceSlug, requestId } = params;
  const maxStored = params.maxStoredEvents ?? (env.isSandbox ? SANDBOX_LIMITS.events : undefined);
  const url = new URL(request.url);

  const [source] = await db.select().from(sources).where(eq(sources.slug, sourceSlug));
  if (!source) {
    return { httpStatus: 404, body: { error: "unknown source" }, deliveryIds: [] };
  }

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_BODY_BYTES) {
    return { httpStatus: 413, body: { error: "payload too large (max 1 MB)" }, deliveryIds: [] };
  }
  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
    return { httpStatus: 413, body: { error: "payload too large (max 1 MB)" }, deliveryIds: [] };
  }

  const verification = verifyRequest({
    scheme: source.scheme,
    secrets: activeSecrets(source, params.now ? new Date(params.now * 1000) : new Date()),
    rawBody,
    headers: request.headers,
    url,
    now: params.now,
  });
  const parsed = tryParseJson(rawBody);
  const storedHeaders = selectHeaders(request.headers);

  if (!verification.ok) {
    // Keep a trace for debugging misconfigured senders, but never deliver it and never let it
    // claim an idempotency key.
    const [rejected] = await db
      .insert(events)
      .values({
        sourceId: source.id,
        idempotencyKey: `rejected:${crypto.randomUUID()}`,
        idempotencyStrategy: "none",
        eventType: parsed.ok ? extractEventType(parsed.value, source.eventTypePath) : null,
        headers: storedHeaders,
        payload: parsed.ok ? parsed.value : null,
        rawBody: rawBody.slice(0, MAX_REJECTED_BODY_CHARS),
        verified: false,
        verificationReason: verification.reason,
        status: "rejected",
      })
      .returning({ id: events.id });
    if (maxStored) await pruneEvents(db, maxStored);
    log("warn", "ingest.rejected", { requestId, source: source.slug, reason: verification.reason, eventId: rejected.id });
    return {
      httpStatus: 401,
      body: { error: "signature verification failed", reason: verification.reason },
      eventId: rejected.id,
      deliveryIds: [],
    };
  }

  if (!parsed.ok) {
    log("warn", "ingest.invalid_json", { requestId, source: source.slug });
    return { httpStatus: 400, body: { error: "body is not valid JSON" }, deliveryIds: [] };
  }

  const { key, strategy } = deriveIdempotencyKey({
    sourceId: source.id,
    rawBody,
    headerValue: request.headers.get("idempotency-key"),
    payload: parsed.value,
  });
  const eventType = extractEventType(parsed.value, source.eventTypePath);

  const activeDestinations = await db
    .select()
    .from(destinations)
    .where(and(eq(destinations.sourceId, source.id), eq(destinations.active, true)));
  const targets = activeDestinations.filter((d) => matchesFilter(eventType, d.eventFilter));

  const outcome = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(events)
      .values({
        sourceId: source.id,
        idempotencyKey: key,
        idempotencyStrategy: strategy,
        eventType,
        headers: storedHeaders,
        payload: parsed.value,
        rawBody,
        verified: true,
        verificationReason: verification.reason,
        status: targets.length > 0 ? "pending" : "no_destinations",
      })
      // The partial unique index (source_id, idempotency_key) WHERE verified makes this race-safe:
      // two concurrent deliveries of the same event cannot both insert.
      .onConflictDoNothing()
      .returning({ id: events.id });

    if (inserted.length === 0) return { duplicate: true as const };

    const eventId = inserted[0].id;
    const rows =
      targets.length > 0
        ? await tx
            .insert(deliveries)
            .values(targets.map((d) => ({ eventId, destinationId: d.id })))
            .returning({ id: deliveries.id })
        : [];
    return { duplicate: false as const, eventId, deliveryIds: rows.map((r) => r.id) };
  });

  if (outcome.duplicate) {
    const [existing] = await db
      .select({ id: events.id })
      .from(events)
      .where(and(eq(events.sourceId, source.id), eq(events.idempotencyKey, key), eq(events.verified, true)));
    log("info", "ingest.duplicate", { requestId, source: source.slug, idempotencyKey: key, eventId: existing?.id });
    return {
      httpStatus: 200,
      body: { duplicate: true, eventId: existing?.id ?? null, idempotencyKey: key },
      eventId: existing?.id,
      deliveryIds: [],
    };
  }

  if (maxStored) await pruneEvents(db, maxStored);
  log("info", "ingest.accepted", {
    requestId,
    source: source.slug,
    eventId: outcome.eventId,
    eventType,
    idempotencyKey: key,
    idempotencyStrategy: strategy,
    deliveries: outcome.deliveryIds.length,
  });
  return {
    httpStatus: 202,
    body: {
      accepted: true,
      eventId: outcome.eventId,
      eventType,
      idempotencyKey: key,
      deliveries: outcome.deliveryIds.length,
    },
    eventId: outcome.eventId,
    deliveryIds: outcome.deliveryIds,
  };
}
