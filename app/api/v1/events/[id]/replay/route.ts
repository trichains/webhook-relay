import { after } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { getDbHandle } from "@/lib/db/client";
import { resolveBaseUrl } from "@/lib/env";
import { log } from "@/lib/log";
import { deliverNow } from "@/lib/services/delivery";
import { replayEvent, ReplayError } from "@/lib/services/replay";

export const maxDuration = 30;

const bodySchema = z.object({ destinationId: z.string().min(1).optional() }).strict();

export async function POST(request: Request, ctx: RouteContext<"/api/v1/events/[id]/replay">) {
  const auth = requireAdmin(request);
  if (auth.response) return auth.response;

  const { id } = await ctx.params;
  const text = await request.text();
  let json: unknown = {};
  if (text.trim()) {
    try {
      json = JSON.parse(text);
    } catch {
      return Response.json({ error: "body must be JSON" }, { status: 400 });
    }
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return Response.json({ error: "invalid body", issues: z.flattenError(parsed.error).fieldErrors }, { status: 400 });
  }

  const handle = await getDbHandle();
  try {
    const ids = await replayEvent(handle.db, id, parsed.data.destinationId);
    const baseUrl = resolveBaseUrl(new URL(request.url).origin);
    after(async () => {
      try {
        await deliverNow(handle, ids, { baseUrl });
      } catch (err) {
        log("error", "replay.after_failed", { eventId: id, error: String(err) });
      }
    });
    return Response.json({ queued: ids.length, deliveryIds: ids }, { status: 202, headers: { "x-relay-auth": auth.mode } });
  } catch (err) {
    if (err instanceof ReplayError) return Response.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
