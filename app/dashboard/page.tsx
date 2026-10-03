import Link from "next/link";
import { connection } from "next/server";
import { ProcessQueueButton } from "@/app/dashboard/_components/forms";
import { Card, EmptyState, EventStatusBadge, formatMs, formatPercent, Mono, PageHeader, Stat, Time } from "@/components/ui";
import { getDbHandle } from "@/lib/db/client";
import { getHourlyVolume, getOverview, listEvents } from "@/lib/queries";
import { currentOrigin } from "@/lib/request-origin";
import { pumpSandboxQueue } from "@/lib/sandbox-pump";

export default async function OverviewPage() {
  await connection();
  const handle = await getDbHandle();
  pumpSandboxQueue(handle, await currentOrigin());
  const [overview, volume, recent] = await Promise.all([
    getOverview(handle.db),
    getHourlyVolume(handle.db, 48),
    listEvents(handle.db, { pageSize: 8 }),
  ]);
  const max = Math.max(1, ...volume.map((b) => b.accepted + b.rejected));
  const rate = overview.successRate;

  return (
    <>
      <PageHeader
        title="Overview"
        description="Last 24 hours across all sources."
        actions={<ProcessQueueButton />}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Events (24h)" value={overview.events24h} hint={`${overview.rejected24h} rejected by signature check`} />
        <Stat
          label="Delivery success (24h)"
          value={formatPercent(rate)}
          tone={rate === null ? undefined : rate >= 0.95 ? "ok" : rate >= 0.8 ? "warn" : "bad"}
          hint={`${overview.settled24h} settled deliveries`}
        />
        <Stat label="Dead letters" value={overview.deadLetters} tone={overview.deadLetters > 0 ? "bad" : undefined} hint={<Link href="/dashboard/dead-letters" className="underline underline-offset-2">open queue</Link>} />
        <Stat label="Latency p50" value={formatMs(overview.p50)} hint={`${overview.attempts24h} attempts`} />
        <Stat label="Latency p95" value={formatMs(overview.p95)} hint={`${overview.pending} deliveries queued`} />
      </div>

      <Card title="Events per hour (48h)" className="mt-4">
        <div className="flex h-28 items-end gap-[3px]" role="img" aria-label="Bar chart of events received per hour over the last 48 hours">
          {volume.map((b) => {
            const total = b.accepted + b.rejected;
            return (
              <div
                key={b.start.toISOString()}
                className="flex flex-1 flex-col justify-end"
                title={`${b.start.toISOString().slice(0, 13).replace("T", " ")}:00 UTC: ${b.accepted} accepted, ${b.rejected} rejected`}
                style={{ height: "100%" }}
              >
                {b.rejected > 0 ? <div className="w-full rounded-t-sm bg-warn/70" style={{ height: `${(b.rejected / max) * 100}%` }} /> : null}
                <div className={`w-full bg-muted/45 ${b.rejected ? "" : "rounded-t-sm"}`} style={{ height: `${(b.accepted / max) * 100}%`, minHeight: total ? 2 : 0 }} />
              </div>
            );
          })}
        </div>
        <div className="mt-2 flex justify-between text-[11px] text-faint">
          <span>48h ago</span>
          <span className="flex gap-3">
            <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-muted/45" /> accepted</span>
            <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-warn/70" /> rejected</span>
          </span>
          <span>now</span>
        </div>
      </Card>

      <Card title="Recent events" className="mt-4" padded={false} actions={<Link href="/dashboard/events" className="text-xs text-muted hover:text-fg">All events →</Link>}>
        {recent.rows.length === 0 ? (
          <EmptyState>No events yet. Send a test webhook from a source.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Event</th>
                  <th>Source</th>
                  <th>Status</th>
                  <th>Received</th>
                </tr>
              </thead>
              <tbody>
                {recent.rows.map((e) => (
                  <tr key={e.id}>
                    <td>
                      <Link href={`/dashboard/events/${e.id}`} className="hover:text-accent">
                        <Mono>{e.eventType ?? "(no type)"}</Mono>
                      </Link>
                    </td>
                    <td className="text-muted">{e.sourceName}</td>
                    <td>
                      <EventStatusBadge status={e.status} />
                    </td>
                    <td>
                      <Time date={e.receivedAt} />
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
