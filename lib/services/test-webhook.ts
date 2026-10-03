import { eq } from "drizzle-orm";
import type { DbHandle } from "@/lib/db/client";
import { sources } from "@/lib/db/schema";
import { hotmartPayload, orderPayload } from "@/lib/samples";
import { ingestWebhook, type IngestResult } from "@/lib/services/ingest";
import { HOTTOK_HEADER, signHmac } from "@/lib/signing";

/** Builds a signed sample request for a source, exactly as a real sender would. */
export async function buildTestRequest(handle: DbHandle, sourceId: string, baseUrl: string) {
  const [source] = await handle.db.select().from(sources).where(eq(sources.id, sourceId));
  if (!source) throw new Error("source not found");

  const payload = source.scheme === "hotmart-hottok" ? hotmartPayload("PURCHASE_APPROVED") : orderPayload("order.paid");
  const rawBody = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "webhook-relay-test-sender/1.0",
  };
  if (source.scheme === "hmac-sha256") {
    headers["x-signature"] = signHmac(source.secret, rawBody);
    headers["idempotency-key"] = `test_${crypto.randomUUID()}`;
  } else if (source.scheme === "hotmart-hottok") {
    headers[HOTTOK_HEADER] = source.secret;
  }
  const url = `${baseUrl.replace(/\/$/, "")}/api/ingest/${source.slug}`;
  return { source, url, rawBody, headers };
}

/**
 * Sends a signed sample webhook to the source's own ingest endpoint.
 *
 * With a real Postgres database this is a genuine HTTP POST to the ingest URL. In sandbox mode the
 * request goes through the same `ingestWebhook` pipeline in-process: on serverless the HTTP call
 * could land on another instance that has its own in-memory database, and the event would vanish.
 */
export async function sendTestWebhook(
  handle: DbHandle,
  sourceId: string,
  baseUrl: string,
): Promise<IngestResult & { inProcess: boolean }> {
  const { source, url, rawBody, headers } = await buildTestRequest(handle, sourceId, baseUrl);

  if (handle.driver === "pglite") {
    const request = new Request(url, { method: "POST", headers, body: rawBody });
    const result = await ingestWebhook(handle, { sourceSlug: source.slug, request });
    return { ...result, inProcess: true };
  }

  const res = await fetch(url, { method: "POST", headers, body: rawBody, cache: "no-store" });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const eventId = typeof body.eventId === "string" ? body.eventId : undefined;
  return { httpStatus: res.status, body, eventId, deliveryIds: [], inProcess: false };
}
