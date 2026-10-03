import { requireCron } from "@/lib/auth";
import { getDbHandle } from "@/lib/db/client";
import { resolveBaseUrl } from "@/lib/env";
import { processQueue } from "@/lib/services/delivery";

export const maxDuration = 60;

/** Queue worker entry point. Vercel Cron calls it every minute (see vercel.json). */
export async function GET(request: Request) {
  const denied = requireCron(request);
  if (denied) return denied;

  const handle = await getDbHandle();
  const started = Date.now();
  const summary = await processQueue(handle, {
    baseUrl: resolveBaseUrl(new URL(request.url).origin),
    limit: 50,
  });
  return Response.json({ ...summary, ms: Date.now() - started });
}
