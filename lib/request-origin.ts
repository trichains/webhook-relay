import { headers } from "next/headers";
import { env, resolveBaseUrl } from "@/lib/env";

/**
 * Base URL for Server Components / Server Actions. Configured URLs take precedence (see
 * resolveBaseUrl); the Host header is only a fallback for local development and previews.
 */
export async function currentOrigin(): Promise<string> {
  if (env.appUrl || process.env.VERCEL_PROJECT_PRODUCTION_URL) return resolveBaseUrl();
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (!host) return resolveBaseUrl();
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return resolveBaseUrl(`${proto.split(",")[0]}://${host}`);
}
