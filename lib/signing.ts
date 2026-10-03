import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { SigningScheme } from "@/lib/db/schema";

export const HMAC_HEADER = "x-signature";
export const HOTTOK_HEADER = "x-hotmart-hottok";
export const DEFAULT_TOLERANCE_SECONDS = 5 * 60;

export type VerificationResult = { ok: boolean; reason: string };

/** Constant-time string comparison. Both sides are hashed first so buffer lengths always match. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

export function hmacHex(secret: string, timestamp: number, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
}

/** Builds the `X-Signature` header value: `t=<unix>,v1=<hex>`. */
export function signHmac(secret: string, rawBody: string, timestamp = Math.floor(Date.now() / 1000)): string {
  return `t=${timestamp},v1=${hmacHex(secret, timestamp, rawBody)}`;
}

export function parseSignatureHeader(header: string): { t: number; v1: string[] } | null {
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const [k, ...rest] = part.trim().split("=");
    const value = rest.join("=");
    if (k === "t" && /^\d+$/.test(value)) t = Number(value);
    else if (k === "v1" && value) v1.push(value);
  }
  if (t === null || v1.length === 0) return null;
  return { t, v1 };
}

export function verifyHmac(
  secret: string,
  rawBody: string,
  header: string | null,
  opts: { now?: number; toleranceSeconds?: number } = {},
): VerificationResult {
  if (!header) return { ok: false, reason: "missing X-Signature header" };
  const parsed = parseSignatureHeader(header);
  if (!parsed) return { ok: false, reason: "malformed X-Signature header (expected t=<unix>,v1=<hex>)" };
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const tolerance = opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(now - parsed.t) > tolerance) {
    return { ok: false, reason: `timestamp outside tolerance (${tolerance}s)` };
  }
  const expected = hmacHex(secret, parsed.t, rawBody);
  // Several v1 values are accepted so a sender can sign with the old and new secret during rotation.
  const match = parsed.v1.some((candidate) => safeEqual(candidate, expected));
  return match ? { ok: true, reason: "valid hmac-sha256 signature" } : { ok: false, reason: "signature mismatch" };
}

export function verifyHottok(secret: string, headerToken: string | null, queryToken: string | null): VerificationResult {
  const token = headerToken ?? queryToken;
  if (!token) return { ok: false, reason: "missing X-HOTMART-HOTTOK header" };
  if (!safeEqual(token, secret)) return { ok: false, reason: "hottok mismatch" };
  return { ok: true, reason: headerToken ? "valid hottok (header)" : "valid hottok (query string)" };
}

export function verifyRequest(params: {
  scheme: SigningScheme;
  secret: string;
  rawBody: string;
  headers: Headers;
  url: URL;
  now?: number;
}): VerificationResult {
  switch (params.scheme) {
    case "hmac-sha256":
      return verifyHmac(params.secret, params.rawBody, params.headers.get(HMAC_HEADER), { now: params.now });
    case "hotmart-hottok":
      return verifyHottok(params.secret, params.headers.get(HOTTOK_HEADER), params.url.searchParams.get("hottok"));
    case "none":
      return { ok: true, reason: "not verified (scheme: none)" };
  }
}

export function generateSecret(scheme: SigningScheme): string {
  if (scheme === "hotmart-hottok") return randomBytes(24).toString("hex");
  return `whsec_${randomBytes(32).toString("base64url")}`;
}
