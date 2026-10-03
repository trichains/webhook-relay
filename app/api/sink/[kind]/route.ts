import { isSinkKind, SINK_KINDS, sinkResponse } from "@/lib/sinks";

export const maxDuration = 10;

/** Built-in demo receivers so the public demo works without external URLs. */
export async function POST(_request: Request, ctx: RouteContext<"/api/sink/[kind]">) {
  const { kind } = await ctx.params;
  if (!isSinkKind(kind)) {
    return Response.json({ error: `unknown sink, use one of: ${SINK_KINDS.join(", ")}` }, { status: 404 });
  }
  return sinkResponse(kind);
}
