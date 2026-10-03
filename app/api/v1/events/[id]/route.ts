import { requireAdmin } from "@/lib/auth";
import { getDbHandle } from "@/lib/db/client";
import { getEventDetail } from "@/lib/queries";

export async function GET(request: Request, ctx: RouteContext<"/api/v1/events/[id]">) {
  const auth = requireAdmin(request);
  if (auth.response) return auth.response;

  const { id } = await ctx.params;
  const { db } = await getDbHandle();
  const detail = await getEventDetail(db, id);
  if (!detail) return Response.json({ error: "event not found" }, { status: 404 });

  const { event, source } = detail;
  return Response.json(
    {
      id: event.id,
      source: { id: source.id, name: source.name, slug: source.slug, scheme: source.scheme },
      eventType: event.eventType,
      status: event.status,
      idempotencyKey: event.idempotencyKey,
      idempotencyStrategy: event.idempotencyStrategy,
      verification: { ok: event.verified, reason: event.verificationReason },
      headers: event.headers,
      payload: event.payload,
      receivedAt: event.receivedAt.toISOString(),
      deliveries: detail.deliveries.map(({ delivery, destination, attempts }) => ({
        id: delivery.id,
        destination: { id: destination.id, name: destination.name, url: destination.url },
        status: delivery.status,
        attemptCount: delivery.attemptCount,
        replayCount: delivery.replayCount,
        nextAttemptAt: delivery.status === "pending" ? delivery.nextAttemptAt.toISOString() : null,
        attempts: attempts.map((a) => ({
          number: a.attemptNumber,
          trigger: a.trigger,
          ok: a.ok,
          statusCode: a.statusCode,
          latencyMs: a.latencyMs,
          error: a.error,
          responseSnippet: a.responseSnippet,
          startedAt: a.startedAt.toISOString(),
        })),
      })),
    },
    { headers: { "x-relay-auth": auth.mode } },
  );
}
