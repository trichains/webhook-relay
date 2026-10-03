export const SINK_KINDS = ["ok", "fail", "flaky", "slow", "reject"] as const;
export type SinkKind = (typeof SINK_KINDS)[number];

export function isSinkKind(value: string): value is SinkKind {
  return (SINK_KINDS as readonly string[]).includes(value);
}

export const SINK_DESCRIPTIONS: Record<SinkKind, string> = {
  ok: "always 200",
  fail: "always 500",
  flaky: "503 about half the time",
  slow: "200 after 3 seconds",
  reject: "always 400 (not retried)",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Behavior of the built-in demo receivers (`/api/sink/<kind>`), so the demo needs no external URLs. */
export async function sinkResponse(kind: SinkKind, opts: { random?: () => number; slowMs?: number } = {}): Promise<Response> {
  const random = opts.random ?? Math.random;
  switch (kind) {
    case "ok":
      return Response.json({ received: true });
    case "fail":
      return Response.json({ error: "internal error" }, { status: 500 });
    case "flaky":
      return random() < 0.5
        ? Response.json({ error: "upstream temporarily unavailable" }, { status: 503 })
        : Response.json({ received: true });
    case "slow": {
      const ms = opts.slowMs ?? 3000;
      await sleep(ms);
      return Response.json({ received: true, slept_ms: ms });
    }
    case "reject":
      return Response.json({ error: "payload rejected: unknown product" }, { status: 400 });
  }
}
