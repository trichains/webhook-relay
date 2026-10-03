import { createHash } from "node:crypto";

export type IdempotencyStrategy = "header" | "payload-id" | "body-hash";

/**
 * Order of preference:
 * 1. `Idempotency-Key` request header (explicit, sender-controlled)
 * 2. top-level `id` field of the payload (Hotmart sends a unique id per event)
 * 3. sha256(sourceId + rawBody) as a last resort (catches byte-identical retries)
 */
export function deriveIdempotencyKey(params: {
  sourceId: string;
  rawBody: string;
  headerValue: string | null;
  payload: unknown;
}): { key: string; strategy: IdempotencyStrategy } {
  const header = params.headerValue?.trim();
  if (header) return { key: header.slice(0, 255), strategy: "header" };

  if (params.payload && typeof params.payload === "object" && !Array.isArray(params.payload)) {
    const id = (params.payload as Record<string, unknown>).id;
    if ((typeof id === "string" && id.trim()) || (typeof id === "number" && Number.isFinite(id))) {
      return { key: String(id).trim().slice(0, 255), strategy: "payload-id" };
    }
  }

  const hash = createHash("sha256").update(params.sourceId).update("\n").update(params.rawBody).digest("hex");
  return { key: `sha256:${hash}`, strategy: "body-hash" };
}
