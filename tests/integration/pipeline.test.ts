import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DbHandle } from "@/lib/db/client";
import { createTestHandle, driverLabel } from "./test-db";
import { attempts, deliveries, destinations, events, sources } from "@/lib/db/schema";
import { SANDBOX_BACKOFF } from "@/lib/backoff";
import {
  attemptClaimedDelivery,
  claimDelivery,
  claimDueDeliveries,
  deliverNow,
  processQueue,
  type EngineOptions,
} from "@/lib/services/delivery";
import { pruneEvents, rotateSourceSecret } from "@/lib/services/sources";
import { ingestWebhook } from "@/lib/services/ingest";
import { replayEvent, retryDeadLetters } from "@/lib/services/replay";
import { buildTestRequest } from "@/lib/services/test-webhook";
import { signHmac } from "@/lib/signing";
import { isSinkKind, sinkResponse } from "@/lib/sinks";
import { seedDatabase } from "@/lib/db/seed";
import { getDestinationsHealth, getOverview, listEvents, listSources } from "@/lib/queries";

const BASE = "http://relay.test";
const SECRET = "whsec_integration";

/** Routes `/api/sink/<kind>` to the real sink logic without a network. */
const fakeFetch: typeof fetch = async (input) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const kind = url.pathname.split("/").pop() ?? "";
  if (url.pathname.startsWith("/api/sink/") && isSinkKind(kind)) return sinkResponse(kind, { slowMs: 1 });
  if (url.pathname === "/redirect") return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } });
  throw new TypeError(`fetch failed: ${url.href}`);
};

let handle: DbHandle;
let clock: Date;
const engine = (): EngineOptions => ({
  baseUrl: BASE,
  fetchImpl: fakeFetch,
  backoff: SANDBOX_BACKOFF,
  now: () => clock,
  random: () => 0.5,
  urlPolicy: { sandbox: true, allowPrivate: false },
});
const realEngine = (): EngineOptions => ({
  ...engine(),
  urlPolicy: { sandbox: false, allowPrivate: false },
  lookup: async () => ["93.184.216.34"],
});

async function createSource(sinks: { kind: string; maxAttempts?: number; filter?: string }[]) {
  const [source] = await handle.db
    .insert(sources)
    .values({ name: "Checkout", slug: "checkout", scheme: "hmac-sha256", secret: SECRET })
    .returning();
  if (sinks.length === 0) return { source, dests: [] };
  const dests = await handle.db
    .insert(destinations)
    .values(
      sinks.map((s, i) => ({
        sourceId: source.id,
        name: `dest-${i}-${s.kind}`,
        url: `/api/sink/${s.kind}`,
        maxAttempts: s.maxAttempts ?? 6,
        eventFilter: s.filter ?? null,
      })),
    )
    .returning();
  return { source, dests };
}

function signedRequest(payload: unknown, extraHeaders: Record<string, string> = {}) {
  const raw = JSON.stringify(payload);
  return new Request(`${BASE}/api/ingest/checkout`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-signature": signHmac(SECRET, raw), ...extraHeaders },
    body: raw,
  });
}

beforeEach(async () => {
  handle = await createTestHandle();
  clock = new Date();
});

afterEach(async () => {
  await handle.close();
});

describe("ingest", () => {
  it("stores a verified event and one delivery per matching active destination", async () => {
    const { dests } = await createSource([{ kind: "ok" }, { kind: "ok", filter: "order.refunded" }, { kind: "fail" }]);
    await handle.db.update(destinations).set({ active: false }).where(eq(destinations.id, dests[2].id));

    const result = await ingestWebhook(handle, {
      sourceSlug: "checkout",
      request: signedRequest({ id: "evt_1", event: "order.paid" }, { "Idempotency-Key": "k-1" }),
    });

    expect(result.httpStatus).toBe(202);
    expect(result.body).toMatchObject({ accepted: true, eventType: "order.paid", idempotencyKey: "k-1", deliveries: 1 });
    const [event] = await handle.db.select().from(events);
    expect(event).toMatchObject({ verified: true, status: "pending", idempotencyStrategy: "header", eventType: "order.paid" });
    expect(event.headers["x-signature"]).toMatch(/^t=\d+,v1=/);
    const rows = await handle.db.select().from(deliveries);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ destinationId: dests[0].id, status: "pending", attemptCount: 0 });
  });

  it("treats a repeated event as a duplicate and does not create new deliveries", async () => {
    await createSource([{ kind: "ok" }]);
    const payload = { id: "hp-123", event: "PURCHASE_APPROVED" };
    const first = await ingestWebhook(handle, { sourceSlug: "checkout", request: signedRequest(payload) });
    await deliverNow(handle, first.deliveryIds, engine());

    // Same logical event, re-sent later with a fresh signature timestamp: idempotency comes from payload.id.
    const second = await ingestWebhook(handle, { sourceSlug: "checkout", request: signedRequest(payload) });

    expect(second.httpStatus).toBe(200);
    expect(second.body).toMatchObject({ duplicate: true, eventId: first.eventId });
    expect(second.deliveryIds).toEqual([]);
    expect(await handle.db.select().from(events)).toHaveLength(1);
    expect(await handle.db.select().from(deliveries)).toHaveLength(1);
    expect(await handle.db.select().from(attempts)).toHaveLength(1);
  });

  it("rejects bad signatures, keeps them for audit and never delivers them", async () => {
    await createSource([{ kind: "ok" }]);
    const raw = JSON.stringify({ id: "x", event: "order.paid" });
    const request = new Request(`${BASE}/api/ingest/checkout`, {
      method: "POST",
      headers: { "x-signature": signHmac("whsec_wrong", raw) },
      body: raw,
    });
    const result = await ingestWebhook(handle, { sourceSlug: "checkout", request });
    expect(result.httpStatus).toBe(401);
    const [event] = await handle.db.select().from(events);
    expect(event).toMatchObject({ verified: false, status: "rejected", verificationReason: "signature mismatch" });
    expect(await handle.db.select().from(deliveries)).toHaveLength(0);

    // The rejected copy must not block the genuine event with the same id.
    const genuine = await ingestWebhook(handle, { sourceSlug: "checkout", request: signedRequest({ id: "x", event: "order.paid" }) });
    expect(genuine.httpStatus).toBe(202);
  });

  it("returns 404 for unknown sources and 400 for invalid JSON", async () => {
    await createSource([{ kind: "ok" }]);
    const unknown = await ingestWebhook(handle, { sourceSlug: "nope", request: signedRequest({}) });
    expect(unknown.httpStatus).toBe(404);
    const bad = new Request(`${BASE}/api/ingest/checkout`, {
      method: "POST",
      headers: { "x-signature": signHmac(SECRET, "{not json") },
      body: "{not json",
    });
    expect((await ingestWebhook(handle, { sourceSlug: "checkout", request: bad })).httpStatus).toBe(400);
  });

  it("accepts the signed request built by the test-webhook sender", async () => {
    const { source } = await createSource([{ kind: "ok" }]);
    const built = await buildTestRequest(handle, source.id, BASE);
    const result = await ingestWebhook(handle, {
      sourceSlug: source.slug,
      request: new Request(built.url, { method: "POST", headers: built.headers, body: built.rawBody }),
    });
    expect(result.httpStatus).toBe(202);
    expect(result.body.eventType).toBe("order.paid");
  });
});

describe("delivery engine", () => {
  it("delivers to a healthy sink on the first attempt", async () => {
    await createSource([{ kind: "ok" }]);
    const res = await ingestWebhook(handle, { sourceSlug: "checkout", request: signedRequest({ id: "a", event: "order.paid" }) });
    const summary = await deliverNow(handle, res.deliveryIds, engine());
    expect(summary).toMatchObject({ claimed: 1, succeeded: 1 });
    const [attempt] = await handle.db.select().from(attempts);
    expect(attempt).toMatchObject({ ok: true, statusCode: 200, attemptNumber: 1, trigger: "initial", responseSnippet: '{"received":true}' });
    const [event] = await handle.db.select().from(events);
    expect(event.status).toBe("delivered");
  });

  it("retries a failing sink with backoff and dead-letters after max attempts", async () => {
    await createSource([{ kind: "fail", maxAttempts: 3 }]);
    const res = await ingestWebhook(handle, { sourceSlug: "checkout", request: signedRequest({ id: "b", event: "order.paid" }) });

    await deliverNow(handle, res.deliveryIds, engine());
    let [delivery] = await handle.db.select().from(deliveries);
    expect(delivery).toMatchObject({ status: "pending", attemptCount: 1, lastStatusCode: 500 });
    // random() = 0.5 → no jitter → exactly the base delay
    expect(delivery.nextAttemptAt.getTime() - clock.getTime()).toBe(SANDBOX_BACKOFF.baseMs);

    // Not due yet: a queue pass right now claims nothing.
    expect((await processQueue(handle, engine())).claimed).toBe(0);

    clock = new Date(clock.getTime() + 2_000);
    expect(await processQueue(handle, engine())).toMatchObject({ claimed: 1, retrying: 1 });
    [delivery] = await handle.db.select().from(deliveries);
    expect(delivery.nextAttemptAt.getTime() - clock.getTime()).toBe(SANDBOX_BACKOFF.baseMs * 2);

    clock = new Date(clock.getTime() + 4_000);
    expect(await processQueue(handle, engine())).toMatchObject({ claimed: 1, deadLettered: 1 });
    [delivery] = await handle.db.select().from(deliveries);
    expect(delivery).toMatchObject({ status: "dead_letter", attemptCount: 3 });

    const history = await handle.db.select().from(attempts).orderBy(attempts.attemptNumber);
    expect(history.map((a) => [a.attemptNumber, a.trigger, a.statusCode])).toEqual([
      [1, "initial", 500],
      [2, "retry", 500],
      [3, "retry", 500],
    ]);
    const [event] = await handle.db.select().from(events);
    expect(event.status).toBe("dead_letter");

    // Dead letters are never picked up by the worker again.
    clock = new Date(clock.getTime() + 3600_000);
    expect((await processQueue(handle, engine())).claimed).toBe(0);
  });

  it("dead-letters a permanent 4xx immediately", async () => {
    await createSource([{ kind: "reject" }]);
    const res = await ingestWebhook(handle, { sourceSlug: "checkout", request: signedRequest({ id: "c", event: "order.paid" }) });
    expect(await deliverNow(handle, res.deliveryIds, engine())).toMatchObject({ deadLettered: 1 });
  });

  it("records network errors without a status code", async () => {
    const { dests } = await createSource([{ kind: "ok" }]);
    await handle.db.update(destinations).set({ url: "https://unreachable.invalid/hook" }).where(eq(destinations.id, dests[0].id));
    const res = await ingestWebhook(handle, { sourceSlug: "checkout", request: signedRequest({ id: "d", event: "order.paid" }) });
    await deliverNow(handle, res.deliveryIds, realEngine());
    const [attempt] = await handle.db.select().from(attempts);
    expect(attempt).toMatchObject({ ok: false, statusCode: null });
    expect(attempt.error).toContain("fetch failed");
    // A network error is transient: the delivery is scheduled for a retry.
    expect((await handle.db.select().from(deliveries))[0].status).toBe("pending");
  });

  it(`never lets two workers claim the same delivery (${driverLabel})`, async () => {
    await createSource([{ kind: "ok" }, { kind: "ok" }, { kind: "ok" }]);
    await ingestWebhook(handle, { sourceSlug: "checkout", request: signedRequest({ id: "e", event: "order.paid" }) });
    const later = new Date(Date.now() + 1000);
    const [a, b] = await Promise.all([claimDueDeliveries(handle, 10, later), claimDueDeliveries(handle, 10, later)]);
    expect(a.length + b.length).toBe(3);
    expect(new Set([...a, ...b]).size).toBe(3);
  });
});

describe("replay", () => {
  it("replaying an event creates a new attempt on the same timeline", async () => {
    const { dests } = await createSource([{ kind: "fail", maxAttempts: 1 }]);
    const res = await ingestWebhook(handle, { sourceSlug: "checkout", request: signedRequest({ id: "f", event: "order.paid" }) });
    await deliverNow(handle, res.deliveryIds, engine());
    expect((await handle.db.select().from(deliveries))[0].status).toBe("dead_letter");

    // Receiver got fixed.
    await handle.db.update(destinations).set({ url: "/api/sink/ok" }).where(eq(destinations.id, dests[0].id));
    const ids = await replayEvent(handle.db, res.eventId!, dests[0].id);
    expect(ids).toEqual(res.deliveryIds);
    expect((await handle.db.select().from(events))[0].status).toBe("pending");

    await deliverNow(handle, ids, engine());
    const history = await handle.db.select().from(attempts).orderBy(attempts.attemptNumber);
    expect(history.map((a) => [a.attemptNumber, a.trigger, a.ok])).toEqual([
      [1, "initial", false],
      [2, "replay", true],
    ]);
    const [delivery] = await handle.db.select().from(deliveries);
    expect(delivery).toMatchObject({ status: "succeeded", replayCount: 1, attemptCount: 1 });
    expect((await handle.db.select().from(events))[0].status).toBe("delivered");
  });

  it("retry-all moves a destination's dead letters back to the queue", async () => {
    const { dests } = await createSource([{ kind: "fail", maxAttempts: 1 }]);
    for (const id of ["g1", "g2"]) {
      const res = await ingestWebhook(handle, { sourceSlug: "checkout", request: signedRequest({ id, event: "order.paid" }) });
      await deliverNow(handle, res.deliveryIds, engine());
    }
    await handle.db.update(destinations).set({ url: "/api/sink/ok" }).where(eq(destinations.id, dests[0].id));
    const ids = await retryDeadLetters(handle.db, dests[0].id);
    expect(ids).toHaveLength(2);
    clock = new Date(Date.now() + 1000);
    expect(await processQueue(handle, engine())).toMatchObject({ claimed: 2, succeeded: 2 });
  });

  it("refuses to replay rejected events", async () => {
    await createSource([{ kind: "ok" }]);
    const request = new Request(`${BASE}/api/ingest/checkout`, { method: "POST", body: "{}" });
    const res = await ingestWebhook(handle, { sourceSlug: "checkout", request });
    await expect(replayEvent(handle.db, res.eventId!)).rejects.toThrow(/cannot be replayed/);
  });
});

describe("outbound URL policy", () => {
  let calls: string[];
  const spyFetch: typeof fetch = async (input, init) => {
    calls.push(String(input));
    return fakeFetch(input, init);
  };
  beforeEach(() => {
    calls = [];
  });

  it("sandbox: refuses a non-sink URL right before the attempt, without any request", async () => {
    const { dests } = await createSource([{ kind: "ok" }]);
    // Written directly to the table, i.e. bypassing the form validation.
    await handle.db.update(destinations).set({ url: "https://example.com/hook" }).where(eq(destinations.id, dests[0].id));
    const res = await ingestWebhook(handle, { sourceSlug: "checkout", request: signedRequest({ id: "s1", event: "order.paid" }) });
    expect(await deliverNow(handle, res.deliveryIds, { ...engine(), fetchImpl: spyFetch })).toMatchObject({ deadLettered: 1 });
    expect(calls).toEqual([]);
    const [attempt] = await handle.db.select().from(attempts);
    expect(attempt).toMatchObject({ ok: false, statusCode: null, error: "blocked: sandbox only delivers to built-in sinks" });
  });

  it("real mode: refuses a hostname that resolves to a private address", async () => {
    const { dests } = await createSource([{ kind: "ok" }]);
    await handle.db.update(destinations).set({ url: "https://rebind.example.com/hook" }).where(eq(destinations.id, dests[0].id));
    const res = await ingestWebhook(handle, { sourceSlug: "checkout", request: signedRequest({ id: "s2", event: "order.paid" }) });
    await deliverNow(handle, res.deliveryIds, { ...realEngine(), fetchImpl: spyFetch, lookup: async () => ["::ffff:10.0.0.7"] });
    expect(calls).toEqual([]);
    const [delivery] = await handle.db.select().from(deliveries);
    expect(delivery.status).toBe("dead_letter");
    expect(delivery.lastError).toMatch(/resolves to a private or reserved address/);
  });

  it("treats a 3xx as a permanent failure and does not follow it", async () => {
    const { dests } = await createSource([{ kind: "ok" }]);
    await handle.db.update(destinations).set({ url: "https://example.com/redirect" }).where(eq(destinations.id, dests[0].id));
    const res = await ingestWebhook(handle, { sourceSlug: "checkout", request: signedRequest({ id: "s3", event: "order.paid" }) });
    await deliverNow(handle, res.deliveryIds, { ...realEngine(), fetchImpl: spyFetch });
    expect(calls).toEqual(["https://example.com/redirect"]);
    const [attempt] = await handle.db.select().from(attempts);
    expect(attempt).toMatchObject({ ok: false, statusCode: 302, error: "redirect not followed (HTTP 302)" });
    expect((await handle.db.select().from(deliveries))[0].status).toBe("dead_letter");
  });
});

describe("stale lock reclaim", () => {
  it("a slow worker whose lock was reclaimed cannot write its result", async () => {
    await createSource([{ kind: "ok" }]);
    const res = await ingestWebhook(handle, { sourceSlug: "checkout", request: signedRequest({ id: "l1", event: "order.paid" }) });
    const t0 = new Date(Date.now() + 1000);
    const slow = await claimDelivery(handle.db, res.deliveryIds[0], t0);
    expect(slow).not.toBeNull();

    // Six minutes later another worker considers the row abandoned and reclaims it.
    const [fresh] = await claimDueDeliveries(handle, 10, new Date(t0.getTime() + 6 * 60_000));
    expect(fresh?.id).toBe(res.deliveryIds[0]);

    // The slow worker finally finishes: its outcome is dropped.
    expect(await attemptClaimedDelivery(handle.db, slow!, engine())).toBeNull();
    expect(await handle.db.select().from(attempts)).toHaveLength(0);
    expect((await handle.db.select().from(deliveries))[0].status).toBe("processing");

    // The worker that owns the lock records exactly one attempt.
    expect(await attemptClaimedDelivery(handle.db, fresh, engine())).toMatchObject({ status: "succeeded" });
    expect(await handle.db.select().from(attempts)).toHaveLength(1);
  });
});

describe("secret rotation", () => {
  it("accepts the previous secret during the grace period only", async () => {
    const { source } = await createSource([{ kind: "ok" }]);
    const rotated = await rotateSourceSecret(handle.db, source.id);
    if (!rotated.ok) throw new Error(rotated.error);

    // SECRET is now the previous secret.
    const old = await ingestWebhook(handle, { sourceSlug: "checkout", request: signedRequest({ id: "r1", event: "order.paid" }) });
    expect(old.httpStatus).toBe(202);
    const [event] = await handle.db.select().from(events).where(eq(events.id, old.eventId!));
    expect(event.verificationReason).toContain("previous secret");

    await handle.db.update(sources).set({ previousSecretExpiresAt: new Date(Date.now() - 1000) }).where(eq(sources.id, source.id));
    const expired = await ingestWebhook(handle, { sourceSlug: "checkout", request: signedRequest({ id: "r2", event: "order.paid" }) });
    expect(expired.httpStatus).toBe(401);

    const raw = JSON.stringify({ id: "r3", event: "order.paid" });
    const current = new Request(`${BASE}/api/ingest/checkout`, {
      method: "POST",
      headers: { "x-signature": signHmac(rotated.secret, raw) },
      body: raw,
    });
    expect((await ingestWebhook(handle, { sourceSlug: "checkout", request: current })).httpStatus).toBe(202);
  });
});

describe("event cap", () => {
  it("drops the oldest events, rejected ones included", async () => {
    await createSource([]);
    const forged = new Request(`${BASE}/api/ingest/checkout`, { method: "POST", body: "{}" });
    expect((await ingestWebhook(handle, { sourceSlug: "checkout", request: forged, maxStoredEvents: 3 })).httpStatus).toBe(401);
    const kept: string[] = [];
    for (const id of ["c1", "c2", "c3"]) {
      await new Promise((r) => setTimeout(r, 5));
      const res = await ingestWebhook(handle, { sourceSlug: "checkout", request: signedRequest({ id, event: "x" }), maxStoredEvents: 3 });
      kept.push(res.eventId!);
    }
    const rows = await handle.db.select({ id: events.id, verified: events.verified }).from(events);
    expect(rows.map((r) => r.id).sort()).toEqual([...kept].sort());
    expect(rows.every((r) => r.verified)).toBe(true);
    expect(await pruneEvents(handle.db, 1)).toBe(2);
  });
});

describe("sandbox seed", () => {
  it("produces a populated, consistent dataset", async () => {
    const counts = await seedDatabase(handle.db);
    expect(counts.events).toBe(60);
    const overview = await getOverview(handle.db);
    expect(overview.events24h).toBeGreaterThan(10);
    expect(overview.deadLetters).toBeGreaterThan(0);
    expect(overview.p95).not.toBeNull();
    const { total } = await listEvents(handle.db, { status: "rejected" });
    expect(total).toBeGreaterThan(0);

    const sourceRows = await listSources(handle.db);
    expect(sourceRows.map((s) => s.destinationCount)).toEqual([2, 2]);
    expect(sourceRows.reduce((t, s) => t + s.events24h, 0)).toBe(overview.events24h);
    const delivered = await listEvents(handle.db, { status: "delivered", pageSize: 5 });
    expect(delivered.rows.every((r) => r.deliveryCount > 0)).toBe(true);
    const health = await getDestinationsHealth(handle.db);
    expect(health).toHaveLength(4);
    expect(health.find((h) => h.destination.url === "/api/sink/fail")?.deadLetters).toBeGreaterThan(0);
  });
});
