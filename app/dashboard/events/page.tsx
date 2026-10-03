import Link from "next/link";
import { connection } from "next/server";
import { Card, EmptyState, EventStatusBadge, Mono, PageHeader, Time } from "@/components/ui";
import { getDbHandle } from "@/lib/db/client";
import { EVENT_STATUSES } from "@/lib/db/schema";
import { listEvents, listEventTypes, listSources, parseEventFilters } from "@/lib/queries";
import { currentOrigin } from "@/lib/request-origin";
import { pumpSandboxQueue } from "@/lib/sandbox-pump";

export const metadata = { title: "Events" };

export default async function EventsPage({ searchParams }: PageProps<"/dashboard/events">) {
  await connection();
  const params = await searchParams;
  const filters = parseEventFilters(params);
  const handle = await getDbHandle();
  pumpSandboxQueue(handle, await currentOrigin());
  const [result, sourceList, types] = await Promise.all([listEvents(handle.db, filters), listSources(handle.db), listEventTypes(handle.db)]);
  const pages = Math.max(1, Math.ceil(result.total / result.pageSize));

  const pageHref = (page: number) => {
    const qs = new URLSearchParams();
    if (filters.sourceId) qs.set("source", filters.sourceId);
    if (filters.status) qs.set("status", filters.status);
    if (filters.eventType) qs.set("type", filters.eventType);
    if (filters.q) qs.set("q", filters.q);
    if (page > 1) qs.set("page", String(page));
    const s = qs.toString();
    return `/dashboard/events${s ? `?${s}` : ""}`;
  };

  return (
    <>
      <PageHeader title="Events" description="Every request received by an ingest endpoint, including the ones rejected by the signature check." />

      <form method="get" className="mb-4 grid gap-2 rounded-lg border border-line bg-surface p-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_1.4fr_auto]" role="search">
        <div>
          <label className="label" htmlFor="f-source">
            Source
          </label>
          <select id="f-source" name="source" className="input" defaultValue={filters.sourceId ?? ""}>
            <option value="">All sources</option>
            {sourceList.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="f-status">
            Status
          </label>
          <select id="f-status" name="status" className="input" defaultValue={filters.status ?? ""}>
            <option value="">Any status</option>
            {EVENT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.replace("_", " ")}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="f-type">
            Event type
          </label>
          <select id="f-type" name="type" className="input" defaultValue={filters.eventType ?? ""}>
            <option value="">Any type</option>
            {types.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="f-q">
            Idempotency key contains
          </label>
          <input id="f-q" name="q" className="input font-mono" placeholder="e.g. idem_ or a Hotmart id" defaultValue={filters.q ?? ""} />
        </div>
        <div className="flex items-end gap-2">
          <button type="submit" className="btn btn-primary">
            Filter
          </button>
          <Link href="/dashboard/events" className="btn">
            Reset
          </Link>
        </div>
      </form>

      <Card padded={false} title={`${result.total} event${result.total === 1 ? "" : "s"}`}>
        {result.rows.length === 0 ? (
          <EmptyState>No events match these filters.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="table" data-testid="events-table">
              <thead>
                <tr>
                  <th>Event type</th>
                  <th>Source</th>
                  <th>Status</th>
                  <th className="hidden md:table-cell">Idempotency key</th>
                  <th className="text-right">Deliveries</th>
                  <th>Received</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((e) => (
                  <tr key={e.id}>
                    <td>
                      <Link href={`/dashboard/events/${e.id}`} className="hover:text-accent">
                        <Mono>{e.eventType ?? "(no type)"}</Mono>
                      </Link>
                    </td>
                    <td className="whitespace-nowrap text-muted">{e.sourceName}</td>
                    <td>
                      <EventStatusBadge status={e.status} />
                    </td>
                    <td className="hidden max-w-[22rem] truncate md:table-cell">
                      <Mono className="text-muted">{e.verified ? e.idempotencyKey : "–"}</Mono>
                    </td>
                    <td className="text-right tabular-nums text-muted">{e.deliveryCount}</td>
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

      {pages > 1 ? (
        <nav className="mt-3 flex items-center justify-between text-sm" aria-label="Pagination">
          <span className="text-muted">
            Page {result.page} of {pages}
          </span>
          <div className="flex gap-2">
            {result.page > 1 ? (
              <Link className="btn btn-sm" href={pageHref(result.page - 1)}>
                ← Newer
              </Link>
            ) : null}
            {result.page < pages ? (
              <Link className="btn btn-sm" href={pageHref(result.page + 1)}>
                Older →
              </Link>
            ) : null}
          </div>
        </nav>
      ) : null}
    </>
  );
}
