"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { z } from "zod";
import { getDbHandle } from "@/lib/db/client";
import { destinations, sources } from "@/lib/db/schema";
import { log } from "@/lib/log";
import { currentOrigin } from "@/lib/request-origin";
import { deliverNow, processQueue, type ProcessSummary } from "@/lib/services/delivery";
import { replayEvent, ReplayError, retryDeadLetters } from "@/lib/services/replay";
import { sendTestWebhook } from "@/lib/services/test-webhook";
import { generateSecret } from "@/lib/signing";
import {
  destinationSchema,
  destinationUpdateSchema,
  formValues,
  slugify,
  sourceSchema,
  sourceUpdateSchema,
  type FieldErrors,
} from "@/lib/validation";

export type ActionState = {
  ok?: boolean;
  message?: string;
  error?: string;
  fieldErrors?: FieldErrors;
  values?: Record<string, string>;
  secret?: string;
  sourceId?: string;
  eventId?: string;
  summary?: ProcessSummary;
};

function revalidateDashboard() {
  revalidatePath("/dashboard", "layout");
}

function validationFailure(error: z.ZodError, values: Record<string, string>): ActionState {
  return { ok: false, error: "Please fix the highlighted fields.", fieldErrors: z.flattenError(error).fieldErrors, values };
}

// ---------------------------------------------------------------- sources

export async function createSourceAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const values = formValues(formData);
  const parsed = sourceSchema.safeParse(values);
  if (!parsed.success) return validationFailure(parsed.error, values);

  const slug = parsed.data.slug || slugify(parsed.data.name);
  if (!slug) return { ok: false, fieldErrors: { slug: ["Could not derive a slug from the name; type one"] }, values };

  const { db } = await getDbHandle();
  const [taken] = await db.select({ id: sources.id }).from(sources).where(eq(sources.slug, slug));
  if (taken) return { ok: false, fieldErrors: { slug: [`"${slug}" is already used by another source`] }, values };

  const secret = generateSecret(parsed.data.scheme);
  const [created] = await db
    .insert(sources)
    .values({
      name: parsed.data.name,
      slug,
      scheme: parsed.data.scheme,
      secret,
      eventTypePath: parsed.data.eventTypePath || "event",
    })
    .returning({ id: sources.id });
  log("info", "source.created", { sourceId: created.id, slug, scheme: parsed.data.scheme });
  revalidateDashboard();
  // The secret is returned once to the browser and never rendered again.
  return { ok: true, message: `Source "${parsed.data.name}" created.`, secret, sourceId: created.id };
}

export async function updateSourceAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const values = formValues(formData);
  const parsed = sourceUpdateSchema.safeParse(values);
  if (!parsed.success) return validationFailure(parsed.error, values);
  const { db } = await getDbHandle();
  const updated = await db
    .update(sources)
    .set({ name: parsed.data.name, eventTypePath: parsed.data.eventTypePath || "event" })
    .where(eq(sources.id, parsed.data.id))
    .returning({ id: sources.id });
  if (updated.length === 0) return { ok: false, error: "Source not found (it may have been deleted)." };
  revalidateDashboard();
  return { ok: true, message: "Saved." };
}

export async function rotateSecretAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const id = String(formData.get("id") ?? "");
  const { db } = await getDbHandle();
  const [source] = await db.select().from(sources).where(eq(sources.id, id));
  if (!source) return { ok: false, error: "Source not found." };
  if (source.scheme === "none") return { ok: false, error: "This source does not use a secret." };
  const secret = generateSecret(source.scheme);
  await db.update(sources).set({ secret }).where(eq(sources.id, id));
  log("info", "source.secret_rotated", { sourceId: id });
  revalidateDashboard();
  return { ok: true, message: "New secret generated. Senders using the old one will now be rejected.", secret };
}

export async function deleteSourceAction(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  const { db } = await getDbHandle();
  await db.delete(sources).where(eq(sources.id, id));
  log("info", "source.deleted", { sourceId: id });
  revalidateDashboard();
  redirect("/dashboard/sources");
}

export async function sendTestWebhookAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const id = String(formData.get("id") ?? "");
  const handle = await getDbHandle();
  const baseUrl = await currentOrigin();
  try {
    const result = await sendTestWebhook(handle, id, baseUrl);
    if (result.inProcess && result.deliveryIds.length > 0) {
      const ids = result.deliveryIds;
      after(async () => {
        try {
          await deliverNow(handle, ids, { baseUrl });
        } catch (err) {
          log("error", "delivery.after_failed", { error: String(err) });
        }
      });
    }
    revalidateDashboard();
    const accepted = result.httpStatus === 202 || result.httpStatus === 200;
    return {
      ok: accepted,
      eventId: result.eventId,
      message: accepted
        ? `Ingest answered ${result.httpStatus}. ${result.deliveryIds.length || "Its"} deliver${result.deliveryIds.length === 1 ? "y is" : "ies are"} on the way.`
        : undefined,
      error: accepted ? undefined : `Ingest answered ${result.httpStatus}: ${JSON.stringify(result.body)}`,
    };
  } catch (err) {
    log("error", "test_webhook.failed", { sourceId: id, error: String(err) });
    return { ok: false, error: `Could not send the test webhook: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ---------------------------------------------------------------- destinations

function destinationInput(formData: FormData) {
  const values = formValues(formData);
  return { values, input: { ...values, active: formData.get("active") === "on" } };
}

export async function createDestinationAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { values, input } = destinationInput(formData);
  const parsed = destinationSchema.safeParse(input);
  if (!parsed.success) return validationFailure(parsed.error, values);
  const { db } = await getDbHandle();
  const [source] = await db.select({ id: sources.id }).from(sources).where(eq(sources.id, parsed.data.sourceId));
  if (!source) return { ok: false, error: "Source not found." };
  await db.insert(destinations).values({ ...parsed.data, eventFilter: parsed.data.eventFilter ?? null });
  log("info", "destination.created", { sourceId: source.id, url: parsed.data.url });
  revalidateDashboard();
  return { ok: true, message: `Destination "${parsed.data.name}" added.` };
}

export async function updateDestinationAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { values, input } = destinationInput(formData);
  const parsed = destinationUpdateSchema.safeParse(input);
  if (!parsed.success) return validationFailure(parsed.error, values);
  const { id, sourceId, ...data } = parsed.data;
  const { db } = await getDbHandle();
  const updated = await db
    .update(destinations)
    .set({ ...data, eventFilter: data.eventFilter ?? null })
    .where(and(eq(destinations.id, id), eq(destinations.sourceId, sourceId)))
    .returning({ id: destinations.id });
  if (updated.length === 0) return { ok: false, error: "Destination not found." };
  revalidateDashboard();
  return { ok: true, message: "Saved." };
}

export async function toggleDestinationAction(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  const active = formData.get("active") === "true";
  const { db } = await getDbHandle();
  await db.update(destinations).set({ active }).where(eq(destinations.id, id));
  log("info", "destination.toggled", { destinationId: id, active });
  revalidateDashboard();
}

export async function deleteDestinationAction(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  const { db } = await getDbHandle();
  await db.delete(destinations).where(eq(destinations.id, id));
  log("info", "destination.deleted", { destinationId: id });
  revalidateDashboard();
}

// ---------------------------------------------------------------- queue, replay

export async function processQueueAction(): Promise<ActionState> {
  const handle = await getDbHandle();
  const summary = await processQueue(handle, { baseUrl: await currentOrigin(), limit: 25 });
  revalidateDashboard();
  return {
    ok: true,
    summary,
    message:
      summary.claimed === 0
        ? "Nothing due right now."
        : `Attempted ${summary.claimed}: ${summary.succeeded} succeeded, ${summary.retrying} scheduled for retry, ${summary.deadLettered} dead-lettered.`,
  };
}

export async function replayEventAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const eventId = String(formData.get("eventId") ?? "");
  const destinationId = String(formData.get("destinationId") ?? "") || undefined;
  const handle = await getDbHandle();
  try {
    const ids = await replayEvent(handle.db, eventId, destinationId);
    // Attempt inline so the result is visible as soon as the page refreshes.
    const summary = await deliverNow(handle, ids, { baseUrl: await currentOrigin() });
    revalidateDashboard();
    return {
      ok: true,
      summary,
      message: `Replayed to ${ids.length} destination${ids.length === 1 ? "" : "s"}: ${summary.succeeded} succeeded${summary.retrying ? `, ${summary.retrying} will retry` : ""}${summary.deadLettered ? `, ${summary.deadLettered} dead-lettered` : ""}.`,
    };
  } catch (err) {
    if (err instanceof ReplayError) return { ok: false, error: err.message };
    throw err;
  }
}

export async function retryDeadLettersAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const destinationId = String(formData.get("destinationId") ?? "");
  const handle = await getDbHandle();
  const ids = await retryDeadLetters(handle.db, destinationId);
  if (ids.length > 0) {
    const baseUrl = await currentOrigin();
    // First batch right after the response; the rest is picked up by the queue worker.
    after(async () => {
      try {
        await deliverNow(handle, ids.slice(0, 25), { baseUrl });
      } catch (err) {
        log("error", "delivery.after_failed", { error: String(err) });
      }
    });
  }
  revalidateDashboard();
  return {
    ok: true,
    message: ids.length === 0 ? "No dead letters for this destination." : `${ids.length} dead letter${ids.length === 1 ? "" : "s"} moved back to the queue.`,
  };
}
