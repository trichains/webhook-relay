import { headers } from "next/headers";
import { resolveBaseUrl } from "@/lib/env";

/** Origin of the current request (Server Components / Server Actions), used for ingest URLs and sinks. */
export async function currentOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (!host) return resolveBaseUrl();
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return resolveBaseUrl(`${proto.split(",")[0]}://${host}`);
}
