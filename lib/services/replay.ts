import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { deliveries, destinations, events } from "@/lib/db/schema";
import { matchesFilter } from "@/lib/event-type";
import { refreshEventStatus } from "@/lib/services/delivery";
import { log } from "@/lib/log";

export class ReplayError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Re-queues an event for delivery. With a destinationId, targets that destination only
 * (even if its filter would skip the event: an explicit replay is a manual override).
 * Without one, targets every active destination of the source whose filter matches.
 *
 * Existing delivery rows are reset in place (attempt cycle back to 0, replay_count + 1) so the
 * full attempt history stays on one timeline. Returns the delivery ids now pending.
 */
export async function replayEvent(db: Db, eventId: string, destinationId?: string): Promise<string[]> {
  const [event] = await db.select().from(events).where(eq(events.id, eventId));
  if (!event) throw new ReplayError("event not found", 404);
  if (!event.verified) throw new ReplayError("rejected events (failed verification) cannot be replayed", 409);

  let targets;
  if (destinationId) {
    targets = await db
      .select()
      .from(destinations)
      .where(and(eq(destinations.id, destinationId), eq(destinations.sourceId, event.sourceId)));
    if (targets.length === 0) throw new ReplayError("destination not found for this event's source", 404);
  } else {
    const all = await db
      .select()
      .from(destinations)
      .where(and(eq(destinations.sourceId, event.sourceId), eq(destinations.active, true)));
    targets = all.filter((d) => matchesFilter(event.eventType, d.eventFilter));
    if (targets.length === 0) throw new ReplayError("no active destination matches this event", 409);
  }

  const now = new Date();
  const ids: string[] = [];
  for (const destination of targets) {
    const [row] = await db
      .insert(deliveries)
      .values({ eventId, destinationId: destination.id, replayCount: 1, nextAttemptAt: now })
      .onConflictDoUpdate({
        target: [deliveries.eventId, deliveries.destinationId],
        set: {
          status: "pending",
          attemptCount: 0,
          replayCount: sql`${deliveries.replayCount} + 1`,
          nextAttemptAt: now,
          lockedAt: null,
          updatedAt: now,
        },
        // Never steal a row another worker is attempting right now.
        setWhere: sql`${deliveries.status} <> 'processing'`,
      })
      .returning({ id: deliveries.id });
    if (row) ids.push(row.id);
  }
  await refreshEventStatus(db, eventId);
  log("info", "replay.event", { eventId, destinationId: destinationId ?? null, queued: ids.length });
  return ids;
}

/** Moves every dead-lettered delivery of a destination back to pending. */
export async function retryDeadLetters(db: Db, destinationId: string): Promise<string[]> {
  const now = new Date();
  const rows = await db
    .update(deliveries)
    .set({
      status: "pending",
      attemptCount: 0,
      replayCount: sql`${deliveries.replayCount} + 1`,
      nextAttemptAt: now,
      lockedAt: null,
      updatedAt: now,
    })
    .where(and(eq(deliveries.destinationId, destinationId), eq(deliveries.status, "dead_letter")))
    .returning({ id: deliveries.id, eventId: deliveries.eventId });

  const eventIds = [...new Set(rows.map((r) => r.eventId))];
  if (eventIds.length > 0) {
    await db.update(events).set({ status: "pending" }).where(inArray(events.id, eventIds));
  }
  log("info", "replay.dead_letters", { destinationId, queued: rows.length });
  return rows.map((r) => r.id);
}
