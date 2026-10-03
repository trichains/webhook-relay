CREATE TABLE "attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"delivery_id" text NOT NULL,
	"attempt_number" integer NOT NULL,
	"trigger" text NOT NULL,
	"ok" boolean NOT NULL,
	"status_code" integer,
	"latency_ms" integer NOT NULL,
	"response_snippet" text,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"destination_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"replay_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"last_status_code" integer,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "destinations" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"event_filter" text,
	"active" boolean DEFAULT true NOT NULL,
	"max_attempts" integer DEFAULT 6 NOT NULL,
	"timeout_ms" integer DEFAULT 10000 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"idempotency_strategy" text NOT NULL,
	"event_type" text,
	"headers" jsonb NOT NULL,
	"payload" jsonb,
	"raw_body" text NOT NULL,
	"verified" boolean NOT NULL,
	"verification_reason" text NOT NULL,
	"status" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"scheme" text NOT NULL,
	"secret" text NOT NULL,
	"event_type_path" text DEFAULT 'event' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sources_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_delivery_id_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_destination_id_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."destinations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "destinations" ADD CONSTRAINT "destinations_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attempts_delivery_idx" ON "attempts" USING btree ("delivery_id");--> statement-breakpoint
CREATE INDEX "attempts_started_at_idx" ON "attempts" USING btree ("started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "deliveries_event_destination_uq" ON "deliveries" USING btree ("event_id","destination_id");--> statement-breakpoint
CREATE INDEX "deliveries_due_idx" ON "deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "deliveries_destination_idx" ON "deliveries" USING btree ("destination_id","status");--> statement-breakpoint
CREATE INDEX "destinations_source_idx" ON "destinations" USING btree ("source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "events_source_idem_verified_uq" ON "events" USING btree ("source_id","idempotency_key") WHERE "events"."verified" = true;--> statement-breakpoint
CREATE INDEX "events_received_at_idx" ON "events" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "events_status_idx" ON "events" USING btree ("status");