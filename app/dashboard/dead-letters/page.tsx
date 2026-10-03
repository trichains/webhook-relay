import Link from "next/link";
import { connection } from "next/server";
import { ReplayForm, RetryDeadLettersButton } from "@/app/dashboard/_components/forms";
import { Badge, Card, EmptyState, Mono, PageHeader, Time } from "@/components/ui";
import { getDbHandle } from "@/lib/db/client";
import { listDeadLetters } from "@/lib/queries";

export const metadata = { title: "Dead letters" };

export default async function DeadLettersPage() {
  await connection();
  const { db } = await getDbHandle();
  const rows = await listDeadLetters(db);

  const groups = new Map<string, { name: string; url: string; items: typeof rows }>();
  for (const row of rows) {
    const g = groups.get(row.destinationId) ?? { name: row.destinationName, url: row.destinationUrl, items: [] };
    g.items.push(row);
    groups.set(row.destinationId, g);
  }

  return (
    <>
      <PageHeader
        title="Dead letters"
        description="Deliveries that used up their attempts or got a permanent 4xx. Nothing here is retried automatically: fix the receiver, then replay."
      />
      {groups.size === 0 ? (
        <Card>
          <EmptyState>The dead-letter queue is empty.</EmptyState>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {[...groups.entries()].map(([destinationId, g]) => (
            <Card
              key={destinationId}
              padded={false}
              title={
                <span className="flex flex-wrap items-center gap-2">
                  {g.name} <Mono className="text-faint">{g.url}</Mono>
                </span>
              }
              actions={<RetryDeadLettersButton destinationId={destinationId} count={g.items.length} />}
            >
              <div className="overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Event</th>
                      <th>Last result</th>
                      <th className="text-right">Attempts</th>
                      <th>Dead-lettered</th>
                      <th>Replay</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.items.map((r) => (
                      <tr key={r.deliveryId}>
                        <td>
                          <Link href={`/dashboard/events/${r.eventId}`} className="hover:text-accent">
                            <Mono>{r.eventType ?? "(no type)"}</Mono>
                          </Link>
                          <div className="text-xs text-faint">
                            received <Time date={r.receivedAt} />
                          </div>
                        </td>
                        <td>
                          <Badge tone="bad">{r.lastStatusCode ?? "no response"}</Badge>
                          {r.lastError && !r.lastError.startsWith("HTTP") ? <span className="ml-2 text-xs text-muted">{r.lastError}</span> : null}
                        </td>
                        <td className="text-right tabular-nums">{r.attemptCount}</td>
                        <td>
                          <Time date={r.updatedAt} />
                        </td>
                        <td>
                          <ReplayForm eventId={r.eventId} destinations={[{ id: r.destinationId, name: r.destinationName, active: true }]} compact />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
