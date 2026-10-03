import Link from "next/link";
import { connection } from "next/server";
import { RetryDeadLettersButton } from "@/app/dashboard/_components/forms";
import { Badge, Card, EmptyState, formatMs, formatPercent, Mono, PageHeader, Time } from "@/components/ui";
import { formatDuration, backoffSchedule } from "@/lib/backoff";
import { getDbHandle } from "@/lib/db/client";
import { defaultBackoff } from "@/lib/services/delivery";
import { getDestinationsHealth } from "@/lib/queries";
import { env } from "@/lib/env";

export const metadata = { title: "Destinations" };

const HEALTH_TONE = { healthy: "ok", degraded: "warn", failing: "bad", paused: "neutral", "no data": "neutral" } as const;

export default async function DestinationsPage() {
  await connection();
  const { db } = await getDbHandle();
  const rows = await getDestinationsHealth(db);
  const schedule = backoffSchedule(6, defaultBackoff()).map(formatDuration).join(" → ");

  return (
    <>
      <PageHeader
        title="Destinations"
        description={
          <>
            Health over the last 24 hours. Retry schedule{env.isSandbox ? " (sandbox, compressed)" : ""}: {schedule}, ±20% jitter. Edit a destination from its source page.
          </>
        }
      />
      <Card padded={false}>
        {rows.length === 0 ? (
          <EmptyState>No destinations yet. Add one from a source.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Destination</th>
                  <th>Health</th>
                  <th className="text-right">Success</th>
                  <th className="text-right">p95</th>
                  <th className="text-right">Attempts</th>
                  <th className="text-right">Queued</th>
                  <th className="text-right">Dead letters</th>
                  <th>Last attempt</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.destination.id}>
                    <td className="min-w-56">
                      <Link href={`/dashboard/sources/${r.destination.sourceId}`} className="font-medium hover:text-accent">
                        {r.destination.name}
                      </Link>
                      <div className="text-xs text-faint">
                        {r.sourceName} · <Mono>{r.destination.url}</Mono>
                      </div>
                      {r.destination.eventFilter ? <div className="text-xs text-faint">only: {r.destination.eventFilter}</div> : null}
                    </td>
                    <td>
                      <Badge tone={HEALTH_TONE[r.health]}>{r.health}</Badge>
                    </td>
                    <td className="text-right tabular-nums">{formatPercent(r.successRate)}</td>
                    <td className="text-right tabular-nums">{formatMs(r.p95)}</td>
                    <td className="text-right tabular-nums text-muted">{r.attempts24h}</td>
                    <td className="text-right tabular-nums text-muted">{r.pending}</td>
                    <td className={`text-right tabular-nums ${r.deadLetters ? "text-bad" : "text-muted"}`}>{r.deadLetters}</td>
                    <td>{r.lastAttemptAt ? <Time date={r.lastAttemptAt} /> : <span className="text-faint">never</span>}</td>
                    <td>
                      <RetryDeadLettersButton destinationId={r.destination.id} count={r.deadLetters} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
