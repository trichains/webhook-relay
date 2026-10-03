import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const SIGNING_SCHEMES = ["hmac-sha256", "hotmart-hottok", "none"] as const;
export type SigningScheme = (typeof SIGNING_SCHEMES)[number];

export const EVENT_STATUSES = ["pending", "delivered", "dead_letter", "rejected", "no_destinations"] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export const DELIVERY_STATUSES = ["pending", "processing", "succeeded", "dead_letter"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const ATTEMPT_TRIGGERS = ["initial", "retry", "replay"] as const;
export type AttemptTrigger = (typeof ATTEMPT_TRIGGERS)[number];

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const sources = pgTable("sources", {
  id: id(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  scheme: text("scheme").$type<SigningScheme>().notNull(),
  secret: text("secret").notNull(),
  /** Dot path used to read the event type from the JSON payload. */
  eventTypePath: text("event_type_path").notNull().default("event"),
  createdAt: createdAt(),
});

export const destinations = pgTable(
  "destinations",
  {
    id: id(),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    url: text("url").notNull(),
    /** Comma-separated event types. Null/empty = all events. */
    eventFilter: text("event_filter"),
    active: boolean("active").notNull().default(true),
    maxAttempts: integer("max_attempts").notNull().default(6),
    timeoutMs: integer("timeout_ms").notNull().default(10000),
    createdAt: createdAt(),
  },
  (t) => [index("destinations_source_idx").on(t.sourceId)],
);

export const events = pgTable(
  "events",
  {
    id: id(),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    idempotencyStrategy: text("idempotency_strategy").notNull(),
    eventType: text("event_type"),
    headers: jsonb("headers").$type<Record<string, string>>().notNull(),
    payload: jsonb("payload"),
    rawBody: text("raw_body").notNull(),
    verified: boolean("verified").notNull(),
    verificationReason: text("verification_reason").notNull(),
    status: text("status").$type<EventStatus>().notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Only verified events claim an idempotency key; rejected requests are kept for audit
    // without letting an unauthenticated caller "burn" a key ahead of the real event.
    uniqueIndex("events_source_idem_verified_uq")
      .on(t.sourceId, t.idempotencyKey)
      .where(sql`${t.verified} = true`),
    index("events_received_at_idx").on(t.receivedAt),
    index("events_status_idx").on(t.status),
  ],
);

export const deliveries = pgTable(
  "deliveries",
  {
    id: id(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    destinationId: text("destination_id")
      .notNull()
      .references(() => destinations.id, { onDelete: "cascade" }),
    status: text("status").$type<DeliveryStatus>().notNull().default("pending"),
    /** Attempts made in the current cycle (reset on replay). Drives backoff and dead-lettering. */
    attemptCount: integer("attempt_count").notNull().default(0),
    /** How many times this delivery was manually replayed / re-queued from the dead-letter queue. */
    replayCount: integer("replay_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lastStatusCode: integer("last_status_code"),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("deliveries_event_destination_uq").on(t.eventId, t.destinationId),
    index("deliveries_due_idx").on(t.status, t.nextAttemptAt),
    index("deliveries_destination_idx").on(t.destinationId, t.status),
  ],
);

export const attempts = pgTable(
  "attempts",
  {
    id: id(),
    deliveryId: text("delivery_id")
      .notNull()
      .references(() => deliveries.id, { onDelete: "cascade" }),
    attemptNumber: integer("attempt_number").notNull(),
    trigger: text("trigger").$type<AttemptTrigger>().notNull(),
    ok: boolean("ok").notNull(),
    statusCode: integer("status_code"),
    latencyMs: integer("latency_ms").notNull(),
    responseSnippet: text("response_snippet"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("attempts_delivery_idx").on(t.deliveryId),
    index("attempts_started_at_idx").on(t.startedAt),
  ],
);

export type Source = typeof sources.$inferSelect;
export type Destination = typeof destinations.$inferSelect;
export type WebhookEvent = typeof events.$inferSelect;
export type Delivery = typeof deliveries.$inferSelect;
export type Attempt = typeof attempts.$inferSelect;
