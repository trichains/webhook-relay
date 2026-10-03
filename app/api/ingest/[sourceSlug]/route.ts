import { after } from "next/server";
import { getDbHandle } from "@/lib/db/client";
import { resolveBaseUrl } from "@/lib/env";
import { log } from "@/lib/log";
import { deliverNow } from "@/lib/services/delivery";
import { ingestWebhook } from "@/lib/services/ingest";

// Leaves room for the first delivery attempt that runs in after().
export const maxDuration = 30;

export async function POST(request: Request, ctx: RouteContext<"/api/ingest/[sourceSlug]">) {
  const { sourceSlug } = await ctx.params;
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  const handle = await getDbHandle();

  let result;
  try {
    result = await ingestWebhook(handle, { sourceSlug, request, requestId });
  } catch (err) {
    log("error", "ingest.failed", { requestId, source: sourceSlug, error: String(err) });
    return Response.json({ error: "internal error" }, { status: 500, headers: { "x-request-id": requestId } });
  }

  if (result.deliveryIds.length > 0) {
    const baseUrl = resolveBaseUrl(new URL(request.url).origin);
    const ids = result.deliveryIds;
    // Respond 202 first; the first attempt runs after the response is sent.
    // Anything that fails here stays pending and is picked up by the cron worker.
    after(async () => {
      try {
        await deliverNow(handle, ids, { baseUrl });
      } catch (err) {
        log("error", "delivery.after_failed", { requestId, error: String(err) });
      }
    });
  }

  return Response.json(result.body, { status: result.httpStatus, headers: { "x-request-id": requestId } });
}
