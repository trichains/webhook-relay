/**
 * Runtime configuration. Everything is optional: with no env vars the app runs
 * in "sandbox mode" (in-memory PGlite, seeded data, open management API).
 */
export const env = {
  get databaseUrl(): string | undefined {
    return process.env.DATABASE_URL || undefined;
  },
  get isSandbox(): boolean {
    return !process.env.DATABASE_URL;
  },
  get adminToken(): string | undefined {
    return process.env.RELAY_ADMIN_TOKEN || undefined;
  },
  get cronSecret(): string | undefined {
    return process.env.CRON_SECRET || undefined;
  },
  get appUrl(): string | undefined {
    return process.env.NEXT_PUBLIC_APP_URL || undefined;
  },
};

/**
 * Base URL used to resolve built-in sink paths (e.g. `/api/sink/ok`) and the
 * "send test webhook" target. Prefers the origin of the current request.
 */
export function resolveBaseUrl(requestOrigin?: string | null): string {
  if (requestOrigin) return requestOrigin.replace(/\/$/, "");
  if (env.appUrl) return env.appUrl.replace(/\/$/, "");
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return `http://localhost:${process.env.PORT ?? 3000}`;
}
