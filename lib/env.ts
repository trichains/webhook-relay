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
 * Base URL used to resolve built-in sink paths (e.g. `/api/sink/ok`), ingest URLs shown in the UI
 * and the "send test webhook" target. Configured values win over the request's Host header,
 * which a client controls: NEXT_PUBLIC_APP_URL, then Vercel's production domain, then the
 * request origin, then the deployment URL, then localhost.
 */
export function resolveBaseUrl(requestOrigin?: string | null): string {
  const strip = (v: string) => v.replace(/\/$/, "");
  if (env.appUrl) return strip(env.appUrl);
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${strip(process.env.VERCEL_PROJECT_PRODUCTION_URL)}`;
  if (requestOrigin) return strip(requestOrigin);
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return `http://localhost:${process.env.PORT ?? 3000}`;
}

/** Absolute site URL for metadata (Open Graph). */
export function siteUrl(): URL {
  return new URL(resolveBaseUrl());
}
