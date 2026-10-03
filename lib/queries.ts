import { and, asc, count, desc, eq, gte, ilike, inArray, sql, type SQL } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import {
  attempts,
  deliveries,
  destinations,
  events,
  sources,
  EVENT_STATUSES,
  type Attempt,
  type EventStatus,
} from "@/lib/db/schema";
import { percentile, successRate } from "@/lib/stats";

const DAY_MS = 24 * 3600_000;
/** Latency stats are computed in JS over at most this many recent attempts. */
const LATENCY_SAMPLE_LIMIT = 10_000;

export async function getOverview(db: Db, now = new Date()) {
  const since = new Date(now.getTime() - DAY_MS);

  const [[eventsCount], [rejectedCount], settled, [deadLetters], [pending], latencyRows] = await Promise.all([
    db.select({ n: count() }).from(events).where(gte(events.receivedAt, since)),
    db
      .select({ n: count() })
      .from(events)
      .where(and(gte(events.receivedAt, since), eq(events.verified, false))),
    db
      .select({ status: deliveries.status, n: count() })
      .from(deliveries)
      .innerJoin(events, eq(events.id, deliveries.eventId))
      .where(and(gte(events.receivedAt, since), inArray(deliveries.status, ["succeeded", "dead_letter"])))
      .groupBy(deliveries.status),
    db.select({ n: count() }).from(deliveries).where(eq(deliveries.status, "dead_letter")),
    db
      .select({ n: count() })
      .from(deliveries)
      .where(inArray(deliveries.status, ["pending", "processing"])),
    db
      .select({ latency: attempts.latencyMs })
      .from(attempts)
      .where(gte(attempts.startedAt, since))
      .orderBy(desc(attempts.startedAt))
      .limit(LATENCY_SAMPLE_LIMIT),
  ]);

  const ok = settled.find((r) => r.status === "succeeded")?.n ?? 0;
  const dead = settled.find((r) => r.status === "dead_letter")?.n ?? 0;
  const latencies = latencyRows.map((r) => r.latency);

  return {
    events24h: eventsCount.n,
    rejected24h: rejectedCount.n,
    successRate: successRate(ok, ok + dead),
    settled24h: ok + dead,
    deadLetters: deadLetters.n,
    pending: pending.n,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    attempts24h: latencies.length,
  };
}

/** Events per hour for the last `hours` hours (oldest first). */
export async function getHourlyVolume(db: Db, hours = 48, now = new Date()) {
  const since = new Date(now.getTime() - hours * 3600_000);
  const rows = await db
    .select({ receivedAt: events.receivedAt, verified: events.verified })
    .from(events)
    .where(gte(events.receivedAt, since));
  const buckets = Array.from({ length: hours }, (_, i) => ({
    start: new Date(since.getTime() + i * 3600_000),
    accepted: 0,
    rejected: 0,
  }));
  for (const row of rows) {
    const idx = Math.min(hours - 1, Math.floor((row.receivedAt.getTime() - since.getTime()) / 3600_000));
    if (idx < 0) continue;
    if (row.verified) buckets[idx].accepted++;
    else buckets[idx].rejected++;
  }
  return buckets;
}

export type EventFilters = {
  sourceId?: string;
  status?: EventStatus;
  eventType?: string;
  q?: string;
  page?: number;
  pageSize?: number;
};

export function parseEventFilters(params: Record<string, string | string[] | undefined>): EventFilters {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
  const status = one(params.status);
  const page = Number(one(params.page) ?? "1");
  return {
    sourceId: one(params.source),
    status: status && (EVENT_STATUSES as readonly string[]).includes(status) ? (status as EventStatus) : undefined,
    eventType: one(params.type),
    q: one(params.q)?.slice(0, 200),
    page: Number.isFinite(page) && page > 0 ? Math.floor(page) : 1,
  };
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export async function listEvents(db: Db, filters: EventFilters) {
  const pageSize = Math.min(200, filters.pageSize ?? 50);
  const page = filters.page ?? 1;
  const conditions: SQL[] = [];
  if (filters.sourceId) conditions.push(eq(events.sourceId, filters.sourceId));
  if (filters.status) conditions.push(eq(events.status, filters.status));
  if (filters.eventType) conditions.push(eq(events.eventType, filters.eventType));
  if (filters.q) conditions.push(ilike(events.idempotencyKey, `%${escapeLike(filters.q)}%`));
  const where = conditions.length ? and(...conditions) : undefined;

  const [rows, [total]] = await Promise.all([
    db
      .select({
        id: events.id,
        eventType: events.eventType,
        idempotencyKey: events.idempotencyKey,
        status: events.status,
        verified: events.verified,
        receivedAt: events.receivedAt,
        sourceId: sources.id,
        sourceName: sources.name,
        // Raw, table-qualified SQL: drizzle renders bare column names inside selected sql fragments.
        deliveryCount: sql<number>`(select count(*)::int from "deliveries" d where d."event_id" = "events"."id")`,
      })
      .from(events)
      .innerJoin(sources, eq(sources.id, events.sourceId))
      .where(where)
      .orderBy(desc(events.receivedAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ n: count() }).from(events).where(where),
  ]);
  return { rows, total: total.n, page, pageSize };
}

export async function listEventTypes(db: Db) {
  const rows = await db
    .selectDistinct({ eventType: events.eventType })
    .from(events)
    .where(sql`${events.eventType} is not null`)
    .orderBy(asc(events.eventType));
  return rows.map((r) => r.eventType as string);
}

export async function getEventDetail(db: Db, id: string) {
  const [row] = await db
    .select({ event: events, source: sources })
    .from(events)
    .innerJoin(sources, eq(sources.id, events.sourceId))
    .where(eq(events.id, id));
  if (!row) return null;

  const deliveryRows = await db
    .select({ delivery: deliveries, destination: destinations })
    .from(deliveries)
    .innerJoin(destinations, eq(destinations.id, deliveries.destinationId))
    .where(eq(deliveries.eventId, id))
    .orderBy(asc(destinations.name));

  const attemptRows = deliveryRows.length
    ? await db
        .select()
        .from(attempts)
        .where(
          inArray(
            attempts.deliveryId,
            deliveryRows.map((d) => d.delivery.id),
          ),
        )
        .orderBy(asc(attempts.attemptNumber))
    : [];

  const byDelivery = new Map<string, Attempt[]>();
  for (const a of attemptRows) {
    const list = byDelivery.get(a.deliveryId) ?? [];
    list.push(a);
    byDelivery.set(a.deliveryId, list);
  }

  const sourceDestinations = await db
    .select({ id: destinations.id, name: destinations.name, active: destinations.active })
    .from(destinations)
    .where(eq(destinations.sourceId, row.source.id))
    .orderBy(asc(destinations.name));

  return {
    ...row,
    deliveries: deliveryRows.map((d) => ({ ...d, attempts: byDelivery.get(d.delivery.id) ?? [] })),
    sourceDestinations,
  };
}

export async function listSources(db: Db, now = new Date()) {
  const since = new Date(now.getTime() - DAY_MS);
  return db
    .select({
      id: sources.id,
      name: sources.name,
      slug: sources.slug,
      scheme: sources.scheme,
      createdAt: sources.createdAt,
      destinationCount: sql<number>`(select count(*)::int from "destinations" d where d."source_id" = "sources"."id")`,
      events24h: sql<number>`(select count(*)::int from "events" e where e."source_id" = "sources"."id" and e."received_at" >= ${since.toISOString()})`,
    })
    .from(sources)
    .orderBy(asc(sources.createdAt), asc(sources.name));
}

export async function getSource(db: Db, id: string) {
  const [source] = await db.select().from(sources).where(eq(sources.id, id));
  if (!source) return null;
  const dests = await db
    .select()
    .from(destinations)
    .where(eq(destinations.sourceId, id))
    .orderBy(asc(destinations.createdAt), asc(destinations.name));
  return { source, destinations: dests };
}

export async function getDestinationsHealth(db: Db, now = new Date()) {
  const since = new Date(now.getTime() - DAY_MS);
  const [dests, attemptRows, statusRows, lastRows] = await Promise.all([
    db
      .select({ destination: destinations, sourceName: sources.name })
      .from(destinations)
      .innerJoin(sources, eq(sources.id, destinations.sourceId))
      .orderBy(asc(sources.name), asc(destinations.name)),
    db
      .select({ destinationId: deliveries.destinationId, ok: attempts.ok, latency: attempts.latencyMs })
      .from(attempts)
      .innerJoin(deliveries, eq(deliveries.id, attempts.deliveryId))
      .where(gte(attempts.startedAt, since))
      .orderBy(desc(attempts.startedAt))
      .limit(LATENCY_SAMPLE_LIMIT),
    db
      .select({ destinationId: deliveries.destinationId, status: deliveries.status, n: count() })
      .from(deliveries)
      .groupBy(deliveries.destinationId, deliveries.status),
    db
      .select({
        destinationId: deliveries.destinationId,
        last: sql<string | null>`max(${attempts.startedAt})`,
      })
      .from(attempts)
      .innerJoin(deliveries, eq(deliveries.id, attempts.deliveryId))
      .groupBy(deliveries.destinationId),
  ]);

  return dests.map(({ destination, sourceName }) => {
    const mine = attemptRows.filter((a) => a.destinationId === destination.id);
    const okCount = mine.filter((a) => a.ok).length;
    const statusCount = (s: string) =>
      statusRows.filter((r) => r.destinationId === destination.id && r.status === s).reduce((t, r) => t + r.n, 0);
    const last = lastRows.find((r) => r.destinationId === destination.id)?.last;
    const rate = successRate(okCount, mine.length);
    return {
      destination,
      sourceName,
      attempts24h: mine.length,
      successRate: rate,
      p95: percentile(
        mine.map((a) => a.latency),
        95,
      ),
      pending: statusCount("pending") + statusCount("processing"),
      deadLetters: statusCount("dead_letter"),
      lastAttemptAt: last ? new Date(last) : null,
      health: healthLabel(destination.active, rate, mine.length),
    };
  });
}

export function healthLabel(active: boolean, rate: number | null, sample: number): "paused" | "no data" | "healthy" | "degraded" | "failing" {
  if (!active) return "paused";
  if (rate === null || sample === 0) return "no data";
  if (rate >= 0.95) return "healthy";
  if (rate >= 0.5) return "degraded";
  return "failing";
}

export async function listDeadLetters(db: Db, destinationId?: string) {
  return db
    .select({
      deliveryId: deliveries.id,
      attemptCount: deliveries.attemptCount,
      lastStatusCode: deliveries.lastStatusCode,
      lastError: deliveries.lastError,
      updatedAt: deliveries.updatedAt,
      eventId: events.id,
      eventType: events.eventType,
      receivedAt: events.receivedAt,
      destinationId: destinations.id,
      destinationName: destinations.name,
      destinationUrl: destinations.url,
    })
    .from(deliveries)
    .innerJoin(events, eq(events.id, deliveries.eventId))
    .innerJoin(destinations, eq(destinations.id, deliveries.destinationId))
    .where(
      destinationId
        ? and(eq(deliveries.status, "dead_letter"), eq(deliveries.destinationId, destinationId))
        : eq(deliveries.status, "dead_letter"),
    )
    .orderBy(desc(deliveries.updatedAt))
    .limit(500);
}
