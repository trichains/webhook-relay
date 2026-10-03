import { z } from "zod";
import { SIGNING_SCHEMES } from "@/lib/db/schema";
import { isSinkKind } from "@/lib/sinks";

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

const PRIVATE_HOST = [
  /^localhost$/i,
  /\.localhost$/i,
  /\.local$/i,
  /\.internal$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^0\./,
  /^\[?::1\]?$/,
  /^\[?f[cd][0-9a-f]{2}:/i,
  /^\[?fe80:/i,
];

/**
 * Destination URL rules:
 * - `/api/sink/<kind>` → one of the built-in demo receivers on this deployment.
 * - otherwise an absolute http(s) URL. In production, hosts that are obviously private
 *   (localhost, RFC 1918, link-local) are refused to limit SSRF from the dashboard.
 *   This is a literal-host check only; DNS rebinding is out of scope (see README).
 */
export function validateDestinationUrl(raw: string, allowPrivate = process.env.NODE_ENV !== "production"): string | null {
  const value = raw.trim();
  if (value.startsWith("/")) {
    const match = /^\/api\/sink\/([a-z]+)$/.exec(value);
    return match && isSinkKind(match[1]) ? null : "Relative URLs must be a built-in sink: /api/sink/ok, fail, flaky, slow or reject";
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Enter a full URL (https://…) or a built-in sink path (/api/sink/ok)";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "Only http and https URLs are supported";
  if (url.username || url.password) return "Credentials in the URL are not allowed; use a token in the receiver instead";
  if (!allowPrivate && PRIVATE_HOST.some((re) => re.test(url.hostname))) {
    return "Private and loopback hosts are not allowed in production";
  }
  return null;
}

const optionalText = z
  .string()
  .trim()
  .transform((v) => v || undefined)
  .optional();

export const sourceSchema = z.object({
  name: z.string().trim().min(2, "Name needs at least 2 characters").max(60, "Keep the name under 60 characters"),
  slug: z
    .string()
    .trim()
    .max(48, "Slug can have at most 48 characters")
    .regex(/^([a-z0-9]+(-[a-z0-9]+)*)?$/, "Use lowercase letters, numbers and single dashes (e.g. hotmart-prod)")
    .optional(),
  scheme: z.enum(SIGNING_SCHEMES, { error: "Pick a signing scheme" }),
  eventTypePath: z
    .string()
    .trim()
    .max(100)
    .regex(/^([A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*)?$/, "Use a dot path like event or data.type")
    .optional(),
});

export const sourceUpdateSchema = sourceSchema.pick({ name: true, eventTypePath: true }).extend({
  id: z.string().min(1),
});

export const destinationSchema = z.object({
  sourceId: z.string().min(1, "Missing source"),
  name: z.string().trim().min(2, "Name needs at least 2 characters").max(60, "Keep the name under 60 characters"),
  url: z
    .string()
    .trim()
    .min(1, "URL is required")
    .max(2000)
    .superRefine((value, ctx) => {
      const error = validateDestinationUrl(value);
      if (error) ctx.addIssue({ code: "custom", message: error });
    }),
  eventFilter: optionalText.pipe(
    z
      .string()
      .max(500)
      .regex(/^[A-Za-z0-9_.:\-]+(\s*,\s*[A-Za-z0-9_.:\-]+)*$/, "Comma-separated event types, e.g. PURCHASE_APPROVED, PURCHASE_COMPLETE")
      .optional(),
  ),
  maxAttempts: z.coerce
    .number({ error: "Max attempts must be a number" })
    .int("Max attempts must be a whole number")
    .min(1, "At least 1 attempt")
    .max(12, "At most 12 attempts"),
  timeoutMs: z.coerce
    .number({ error: "Timeout must be a number" })
    .int()
    .min(1000, "Timeout must be at least 1000 ms")
    .max(30000, "Timeout must be at most 30000 ms"),
  active: z.boolean(),
});

export const destinationUpdateSchema = destinationSchema.extend({ id: z.string().min(1) });

export type FieldErrors = Record<string, string[] | undefined>;

export function formValues(formData: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of formData.entries()) if (typeof v === "string") out[k] = v;
  return out;
}
