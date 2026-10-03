import { safeEqual } from "@/lib/signing";
import { env } from "@/lib/env";

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header?.toLowerCase().startsWith("bearer ")) return null;
  return header.slice(7).trim() || null;
}

function unauthorized(message: string) {
  return Response.json({ error: message }, { status: 401, headers: { "www-authenticate": "Bearer" } });
}

/**
 * Management API guard.
 * - RELAY_ADMIN_TOKEN set → bearer token required.
 * - not set, sandbox mode → open (responses carry `x-relay-auth: open-sandbox`).
 * - not set, real database → fail closed.
 */
export function requireAdmin(request: Request): { response: Response | null; mode: "token" | "open-sandbox" } {
  const token = env.adminToken;
  if (token) {
    const provided = bearer(request);
    if (!provided || !safeEqual(provided, token)) return { response: unauthorized("invalid or missing bearer token"), mode: "token" };
    return { response: null, mode: "token" };
  }
  if (env.isSandbox) return { response: null, mode: "open-sandbox" };
  return {
    response: Response.json({ error: "RELAY_ADMIN_TOKEN is not configured" }, { status: 503 }),
    mode: "token",
  };
}

/** Cron guard: Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` when CRON_SECRET is set. */
export function requireCron(request: Request): Response | null {
  const secret = env.cronSecret;
  if (!secret) return null;
  const provided = bearer(request);
  if (!provided || !safeEqual(provided, secret)) return unauthorized("invalid or missing cron secret");
  return null;
}
