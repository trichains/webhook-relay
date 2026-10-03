import { z } from "zod";
import { SIGNING_SCHEMES } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { validateDestinationUrl, type UrlPolicy } from "@/lib/ssrf";

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/** Destination URL policy for the current environment (see lib/ssrf.ts). */
export function currentUrlPolicy(): UrlPolicy {
  return { sandbox: env.isSandbox, allowPrivate: !env.isSandbox && process.env.NODE_ENV !== "production" };
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
      const error = validateDestinationUrl(value, currentUrlPolicy());
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
