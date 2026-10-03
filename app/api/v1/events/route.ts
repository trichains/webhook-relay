import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { getDbHandle } from "@/lib/db/client";
import { EVENT_STATUSES } from "@/lib/db/schema";
import { listEvents } from "@/lib/queries";

const querySchema = z.object({
  source: z.string().min(1).optional(),
  status: z.enum(EVENT_STATUSES).optional(),
  type: z.string().min(1).max(120).optional(),
  q: z.string().min(1).max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(200).default(50),
});

export async function GET(request: Request) {
  const auth = requireAdmin(request);
  if (auth.response) return auth.response;

  // Empty parameters (?source=) mean "no filter".
  const params = Object.fromEntries([...new URL(request.url).searchParams].filter(([, v]) => v.trim() !== ""));
  const parsed = querySchema.safeParse(params);
  if (!parsed.success) {
    return Response.json({ error: "invalid query", issues: z.flattenError(parsed.error).fieldErrors }, { status: 400 });
  }
  const { source, status, type, q, page, page_size } = parsed.data;
  const { db } = await getDbHandle();
  const result = await listEvents(db, { sourceId: source, status, eventType: type, q, page, pageSize: page_size });

  return Response.json(
    {
      data: result.rows.map((r) => ({
        id: r.id,
        source: { id: r.sourceId, name: r.sourceName },
        eventType: r.eventType,
        status: r.status,
        verified: r.verified,
        idempotencyKey: r.idempotencyKey,
        deliveries: r.deliveryCount,
        receivedAt: r.receivedAt.toISOString(),
      })),
      page: result.page,
      pageSize: result.pageSize,
      total: result.total,
    },
    { headers: { "x-relay-auth": auth.mode } },
  );
}
