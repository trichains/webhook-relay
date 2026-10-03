import { count, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { destinations, events, sources } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { log } from "@/lib/log";
import { generateSecret } from "@/lib/signing";

/** How long the previous secret keeps verifying after a rotation. */
export const SECRET_GRACE_MS = 24 * 3600_000;

/** Slugs of the sources created by the sandbox seed. */
export const SEED_SOURCE_SLUGS = ["store-checkout", "hotmart"] as const;

/** Sandbox limits so the public demo stays usable for the next visitor. */
export const SANDBOX_LIMITS = { events: 2000, sources: 25, destinationsPerSource: 10 } as const;

/** Demo sources are read-only in sandbox mode (no delete, no secret rotation). */
export function isProtectedSource(slug: string, sandbox = env.isSandbox): boolean {
  return sandbox && (SEED_SOURCE_SLUGS as readonly string[]).includes(slug);
}

/**
 * Generates a new secret and keeps the old one valid for SECRET_GRACE_MS, so senders can be
 * updated without dropping events in between.
 */
export async function rotateSourceSecret(db: Db, id: string, now = new Date()) {
  const [source] = await db.select().from(sources).where(eq(sources.id, id));
  if (!source) return { ok: false as const, error: "Source not found." };
  if (source.scheme === "none") return { ok: false as const, error: "This source does not use a secret." };
  if (isProtectedSource(source.slug)) {
    return { ok: false as const, error: "Demo sources are read-only in the sandbox. Create your own source to get a secret." };
  }
  const secret = generateSecret(source.scheme);
  const previousSecretExpiresAt = new Date(now.getTime() + SECRET_GRACE_MS);
  await db
    .update(sources)
    .set({ secret, previousSecret: source.secret, previousSecretExpiresAt })
    .where(eq(sources.id, id));
  log("info", "source.secret_rotated", { sourceId: id, previousValidUntil: previousSecretExpiresAt.toISOString() });
  return { ok: true as const, secret, previousSecretExpiresAt };
}

export async function revokePreviousSecret(db: Db, id: string) {
  await db.update(sources).set({ previousSecret: null, previousSecretExpiresAt: null }).where(eq(sources.id, id));
  log("info", "source.previous_secret_revoked", { sourceId: id });
}

/** Deletes the oldest events (rejected ones included) beyond `max`. Deliveries/attempts cascade. */
export async function pruneEvents(db: Db, max: number): Promise<number> {
  const overflow = db.select({ id: events.id }).from(events).orderBy(desc(events.receivedAt), desc(events.id)).offset(max);
  const deleted = await db.delete(events).where(inArray(events.id, overflow)).returning({ id: events.id });
  if (deleted.length > 0) log("info", "events.pruned", { deleted: deleted.length, max });
  return deleted.length;
}

export async function countSources(db: Db): Promise<number> {
  const [row] = await db.select({ n: count() }).from(sources);
  return row.n;
}

export async function countDestinations(db: Db, sourceId: string): Promise<number> {
  const [row] = await db.select({ n: count() }).from(destinations).where(eq(destinations.sourceId, sourceId));
  return row.n;
}
