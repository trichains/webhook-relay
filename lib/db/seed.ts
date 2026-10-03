import type { Db } from "@/lib/db/client";
import { attempts, deliveries, destinations, events, sources, type DeliveryStatus } from "@/lib/db/schema";
import { backoffDelayMs, SANDBOX_BACKOFF } from "@/lib/backoff";
import { matchesFilter } from "@/lib/event-type";
import { computeEventStatus } from "@/lib/services/delivery";
import { SEED_SOURCE_SLUGS } from "@/lib/services/sources";
import { generateSecret, signHmac } from "@/lib/signing";
import { hotmartPayload, mulberry32, orderPayload, type Rng } from "@/lib/samples";

type SinkKind = "ok" | "flaky" | "slow" | "fail";

function weighted<T>(rng: Rng, entries: [T, number][]): T {
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let roll = rng() * total;
  for (const [value, w] of entries) {
    roll -= w;
    if (roll <= 0) return value;
  }
  return entries[entries.length - 1][0];
}

function simulateAttempt(kind: SinkKind, rng: Rng): { ok: boolean; statusCode: number; latencyMs: number; snippet: string } {
  switch (kind) {
    case "ok":
      return { ok: true, statusCode: 200, latencyMs: Math.round(35 + rng() * 110), snippet: '{"received":true}' };
    case "slow":
      return { ok: true, statusCode: 200, latencyMs: Math.round(3005 + rng() * 140), snippet: '{"received":true,"slept_ms":3000}' };
    case "fail":
      return { ok: false, statusCode: 500, latencyMs: Math.round(20 + rng() * 60), snippet: '{"error":"internal error"}' };
    case "flaky": {
      const ok = rng() < 0.5;
      return ok
        ? { ok, statusCode: 200, latencyMs: Math.round(60 + rng() * 200), snippet: '{"received":true}' }
        : { ok, statusCode: 503, latencyMs: Math.round(30 + rng() * 120), snippet: '{"error":"upstream temporarily unavailable"}' };
    }
  }
}

/**
 * Sandbox fixture: 2 sources, 4 destinations on the built-in sinks and ~60 events spread
 * over the last 48h, with delivery histories that match each sink's behavior.
 * Deterministic (seeded PRNG) apart from secrets and the "now" anchor.
 */
export async function seedDatabase(db: Db, now = new Date()) {
  const rng = mulberry32(20261002);

  const checkout = {
    id: crypto.randomUUID(),
    name: "Store checkout",
    slug: SEED_SOURCE_SLUGS[0],
    scheme: "hmac-sha256" as const,
    secret: generateSecret("hmac-sha256"),
    eventTypePath: "event",
  };
  const hotmart = {
    id: crypto.randomUUID(),
    name: "Hotmart",
    slug: SEED_SOURCE_SLUGS[1],
    scheme: "hotmart-hottok" as const,
    secret: generateSecret("hotmart-hottok"),
    eventTypePath: "event",
  };
  await db.insert(sources).values([checkout, hotmart]);

  const dests = [
    { id: crypto.randomUUID(), sourceId: checkout.id, name: "Fulfillment API", url: "/api/sink/ok", eventFilter: "order.paid", maxAttempts: 6, timeoutMs: 10000, kind: "ok" as SinkKind },
    { id: crypto.randomUUID(), sourceId: checkout.id, name: "CRM sync", url: "/api/sink/flaky", eventFilter: null, maxAttempts: 6, timeoutMs: 10000, kind: "flaky" as SinkKind },
    { id: crypto.randomUUID(), sourceId: hotmart.id, name: "Member area provisioning", url: "/api/sink/slow", eventFilter: "PURCHASE_APPROVED,PURCHASE_COMPLETE", maxAttempts: 6, timeoutMs: 10000, kind: "slow" as SinkKind },
    { id: crypto.randomUUID(), sourceId: hotmart.id, name: "Refund handler (legacy ERP)", url: "/api/sink/fail", eventFilter: "PURCHASE_CANCELED,PURCHASE_REFUNDED,PURCHASE_CHARGEBACK", maxAttempts: 4, timeoutMs: 10000, kind: "fail" as SinkKind },
  ];
  await db.insert(destinations).values(
    dests.map((d) => ({ id: d.id, sourceId: d.sourceId, name: d.name, url: d.url, eventFilter: d.eventFilter, maxAttempts: d.maxAttempts, timeoutMs: d.timeoutMs })),
  );

  const eventRows: (typeof events.$inferInsert)[] = [];
  const deliveryRows: (typeof deliveries.$inferInsert)[] = [];
  const attemptRows: (typeof attempts.$inferInsert)[] = [];

  const TOTAL = 60;
  const offsets = Array.from({ length: TOTAL }, () => rng() * 48 * 3600_000).sort((a, b) => b - a);

  offsets.forEach((offset, index) => {
    const receivedAt = new Date(now.getTime() - offset - 5 * 60_000);
    const isHotmart = rng() < 0.5;
    const source = isHotmart ? hotmart : checkout;
    const eventType = isHotmart
      ? weighted(rng, [
          ["PURCHASE_APPROVED", 40],
          ["PURCHASE_COMPLETE", 15],
          ["PURCHASE_BILLET_PRINTED", 10],
          ["PURCHASE_CANCELED", 10],
          ["PURCHASE_REFUNDED", 12],
          ["PURCHASE_CHARGEBACK", 5],
          ["SUBSCRIPTION_CANCELLATION", 8],
        ])
      : weighted(rng, [
          ["order.paid", 45],
          ["order.created", 25],
          ["order.refunded", 10],
          ["subscription.renewed", 12],
          ["checkout.abandoned", 8],
        ]);
    const payload = isHotmart ? hotmartPayload(eventType, rng, receivedAt) : orderPayload(eventType, rng, receivedAt);
    const rawBody = JSON.stringify(payload);
    const ts = Math.floor(receivedAt.getTime() / 1000);
    const rejected = index % 17 === 5; // a handful of bad signatures for the audit log

    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": "webhook-relay-seed/1.0",
    };
    if (isHotmart) {
      headers["x-hotmart-hottok"] = rejected ? "bad0…(redacted)" : `${hotmart.secret.slice(0, 4)}…(redacted)`;
    } else {
      headers["x-signature"] = rejected ? `t=${ts},v1=${"0".repeat(64)}` : signHmac(checkout.secret, rawBody, ts);
    }

    const eventId = crypto.randomUUID();
    if (rejected) {
      eventRows.push({
        id: eventId,
        sourceId: source.id,
        idempotencyKey: `rejected:${crypto.randomUUID()}`,
        idempotencyStrategy: "none",
        eventType,
        headers,
        payload,
        rawBody,
        verified: false,
        verificationReason: isHotmart ? "hottok mismatch" : "signature mismatch",
        status: "rejected",
        receivedAt,
      });
      return;
    }

    const statuses: DeliveryStatus[] = [];
    const targets = dests.filter((d) => d.sourceId === source.id && matchesFilter(eventType, d.eventFilter));
    for (const dest of targets) {
      const deliveryId = crypto.randomUUID();
      let at = receivedAt.getTime() + 150;
      let status: DeliveryStatus = "pending";
      let count = 0;
      let last: ReturnType<typeof simulateAttempt> | null = null;
      const isRecent = offset < 20 * 60_000;
      // Leave the most recent flaky deliveries mid-retry so the queue has live work.
      const maxSimulated = dest.kind === "flaky" && isRecent ? 1 : dest.maxAttempts;

      while (count < maxSimulated) {
        last = simulateAttempt(dest.kind, rng);
        count++;
        attemptRows.push({
          deliveryId,
          attemptNumber: count,
          trigger: count === 1 ? "initial" : "retry",
          ok: last.ok,
          statusCode: last.statusCode,
          latencyMs: last.latencyMs,
          responseSnippet: last.snippet,
          error: last.ok ? null : `HTTP ${last.statusCode}`,
          startedAt: new Date(at),
        });
        if (last.ok) {
          status = "succeeded";
          break;
        }
        at += last.latencyMs + backoffDelayMs(count, SANDBOX_BACKOFF, rng);
      }
      if (!last?.ok) status = count >= dest.maxAttempts ? "dead_letter" : "pending";

      statuses.push(status);
      deliveryRows.push({
        id: deliveryId,
        eventId,
        destinationId: dest.id,
        status,
        attemptCount: count,
        nextAttemptAt: status === "pending" ? new Date(now.getTime() + 15_000) : new Date(at),
        lastStatusCode: last?.statusCode ?? null,
        lastError: last && !last.ok ? `HTTP ${last.statusCode}` : null,
        createdAt: receivedAt,
        updatedAt: new Date(at),
      });
    }

    const idempotency = isHotmart
      ? { idempotencyKey: (payload as { id: string }).id, idempotencyStrategy: "payload-id" }
      : { idempotencyKey: `idem_${(payload as { id: string }).id.slice(4, 20)}`, idempotencyStrategy: "header" };
    if (!isHotmart) headers["idempotency-key"] = idempotency.idempotencyKey;

    eventRows.push({
      id: eventId,
      sourceId: source.id,
      ...idempotency,
      eventType,
      headers,
      payload,
      rawBody,
      verified: true,
      verificationReason: isHotmart ? "valid hottok (header)" : "valid hmac-sha256 signature",
      status: computeEventStatus(statuses),
      receivedAt,
    });
  });

  await db.insert(events).values(eventRows);
  if (deliveryRows.length) await db.insert(deliveries).values(deliveryRows);
  if (attemptRows.length) await db.insert(attempts).values(attemptRows);

  return { sources: 2, destinations: dests.length, events: eventRows.length, deliveries: deliveryRows.length, attempts: attemptRows.length };
}
