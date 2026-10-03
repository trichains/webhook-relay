import { after } from "next/server";
import type { DbHandle } from "@/lib/db/client";
import { env } from "@/lib/env";
import { log } from "@/lib/log";
import { processQueue } from "@/lib/services/delivery";

/**
 * Sandbox only: Vercel Cron is not guaranteed to hit the same warm instance that holds the
 * in-memory database, so dashboard page views also run a small queue pass after the response.
 * With a real database this does nothing; the cron worker owns the queue.
 */
export function pumpSandboxQueue(handle: DbHandle, baseUrl: string) {
  if (!env.isSandbox || handle.driver !== "pglite") return;
  after(async () => {
    try {
      await processQueue(handle, { baseUrl, limit: 10 });
    } catch (err) {
      log("error", "sandbox.pump_failed", { error: String(err) });
    }
  });
}
