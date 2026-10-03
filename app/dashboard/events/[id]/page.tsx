import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { ReplayForm } from "@/app/dashboard/_components/forms";
import { AutoRefresh, CopyButton } from "@/components/client";
import {
  Badge,
  Card,
  DeliveryStatusBadge,
  EmptyState,
  EventStatusBadge,
  formatMs,
  formatUtc,
  Mono,
  PageHeader,
  relativeTime,
  SchemeBadge,
  Time,
} from "@/components/ui";
import { getDbHandle } from "@/lib/db/client";
import { getEventDetail } from "@/lib/queries";
import { currentOrigin } from "@/lib/request-origin";
import { pumpSandboxQueue } from "@/lib/sandbox-pump";

export const metadata = { title: "Event" };

const STRATEGY_LABEL: Record<string, string> = {
  header: "Idempotency-Key header",
  "payload-id": "payload id field",
  "body-hash": "sha256 of source + raw body",
  none: "not assigned (rejected)",
};

/** Pretty-prints the raw body so keys keep the sender's order (jsonb reorders them). */
function prettyBody(rawBody: string, payload: unknown): string {
  try {
    return JSON.stringify(JSON.parse(rawBody), null, 2);
  } catch {
    return payload !== null ? JSON.stringify(payload, null, 2) : rawBody;
  }
}

export default async function EventPage({ params }: PageProps<"/dashboard/events/[id]">) {
  await connection();
  const { id } = await params;
  const handle = await getDbHandle();
  pumpSandboxQueue(handle, await currentOrigin());
  const detail = await getEventDetail(handle.db, id);
  if (!detail) notFound();

  const { event, source } = detail;
  const inFlight = detail.deliveries.some((d) => d.delivery.status === "pending" || d.delivery.status === "processing");
  const payloadText = prettyBody(event.rawBody, event.payload);

  return (
    <>
      <div className="mb-2 text-xs text-muted">
        <Link href="/dashboard/events" className="hover:text-fg">
          ← Events
        </Link>
      </div>
      <PageHeader
        title={event.eventType ?? "(no event type)"}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <EventStatusBadge status={event.status} />
            <span>
              from{" "}
              <Link href={`/dashboard/sources/${source.id}`} className="text-fg underline decoration-line-strong underline-offset-2">
                {source.name}
              </Link>
            </span>
            <span>·</span>
            <span title={formatUtc(event.receivedAt)}>received {relativeTime(event.receivedAt)}</span>
            <AutoRefresh active={inFlight} />
          </span>
        }
        actions={event.verified ? <ReplayForm eventId={event.id} destinations={detail.sourceDestinations} /> : null}
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card title="Verification">
            <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-2 text-sm">
              <dt className="text-muted">Result</dt>
              <dd>
                {event.verified ? (
                  source.scheme === "none" ? (
                    <Badge tone="warn">accepted without check</Badge>
                  ) : (
                    <Badge tone="ok">verified</Badge>
                  )
                ) : (
                  <Badge tone="bad">rejected (401)</Badge>
                )}
                <span className="ml-2 text-muted" data-testid="verification-reason">
                  {event.verificationReason}
                </span>
              </dd>
              <dt className="text-muted">Scheme</dt>
              <dd>
                <SchemeBadge scheme={source.scheme} />
              </dd>
              <dt className="text-muted">Idempotency key</dt>
              <dd className="min-w-0 break-all">
                <Mono>{event.idempotencyKey}</Mono>
                <div className="text-xs text-faint">from {STRATEGY_LABEL[event.idempotencyStrategy] ?? event.idempotencyStrategy}</div>
              </dd>
              <dt className="text-muted">Event id</dt>
              <dd className="break-all">
                <Mono>{event.id}</Mono>
              </dd>
              <dt className="text-muted">Received</dt>
              <dd>{formatUtc(event.receivedAt)}</dd>
            </dl>
          </Card>

          <Card title="Headers" padded={false}>
            {Object.keys(event.headers).length === 0 ? (
              <EmptyState>No headers stored.</EmptyState>
            ) : (
              <table className="table">
                <tbody>
                  {Object.entries(event.headers).map(([k, v]) => (
                    <tr key={k}>
                      <td className="w-44 align-top">
                        <Mono className="text-muted">{k}</Mono>
                      </td>
                      <td className="break-all">
                        <Mono>{v}</Mono>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <Card title={event.payload !== null ? "Payload" : "Raw body (not valid JSON)"} actions={<CopyButton value={payloadText} label="Copy JSON" />} padded={false}>
            <pre className="max-h-[32rem] overflow-auto p-4 font-mono text-[12px] leading-relaxed text-fg/90" data-testid="payload">
              {payloadText}
            </pre>
          </Card>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          {detail.deliveries.length === 0 ? (
            <Card title="Deliveries">
              <EmptyState>
                {event.verified ? "No active destination matched this event type." : "Rejected events are stored for audit and never delivered."}
              </EmptyState>
            </Card>
          ) : (
            detail.deliveries.map(({ delivery, destination, attempts }) => (
              <Card
                key={delivery.id}
                title={
                  <span className="flex flex-wrap items-center gap-2">
                    {destination.name}
                    <DeliveryStatusBadge status={delivery.status} attemptCount={delivery.attemptCount} />
                  </span>
                }
                actions={<Mono className="text-faint">{destination.url}</Mono>}
              >
                <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                  <span>
                    {delivery.attemptCount} of {destination.maxAttempts} attempts used{delivery.replayCount > 0 ? " since last replay" : ""}
                  </span>
                  {delivery.replayCount > 0 ? <span>replayed {delivery.replayCount}×</span> : null}
                  {delivery.status === "pending" && delivery.attemptCount > 0 ? (
                    <span className="text-warn">next attempt {relativeTime(delivery.nextAttemptAt)}</span>
                  ) : null}
                  <span>timeout {formatMs(destination.timeoutMs)}</span>
                </div>
                {attempts.length === 0 ? (
                  <p className="text-sm text-muted">Queued, no attempt yet.</p>
                ) : (
                  <ol className="relative ml-1.5 border-l border-line" data-testid="attempts">
                    {attempts.map((a) => (
                      <li key={a.id} className="relative pb-3 pl-4 last:pb-0" data-testid="attempt" data-ok={a.ok}>
                        <span className={`absolute -left-[5px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-surface ${a.ok ? "bg-ok" : "bg-bad"}`} aria-hidden />
                        <div className="flex flex-wrap items-center gap-2 text-sm">
                          <span className="font-medium">#{a.attemptNumber}</span>
                          <Badge tone={a.ok ? "ok" : "bad"}>{a.statusCode ?? "no response"}</Badge>
                          <span className="text-xs text-muted">{a.trigger}</span>
                          <span className="text-xs tabular-nums text-muted">{formatMs(a.latencyMs)}</span>
                          <span className="text-xs">
                            <Time date={a.startedAt} />
                          </span>
                        </div>
                        {a.error && !/^HTTP \d+$/.test(a.error) ? <div className="mt-0.5 text-xs text-bad">{a.error}</div> : null}
                        {a.responseSnippet ? (
                          <details className="mt-1">
                            <summary className="cursor-pointer text-xs text-faint hover:text-muted">response body</summary>
                            <pre className="mt-1 overflow-x-auto rounded bg-bg p-2 font-mono text-[11px] text-muted">{a.responseSnippet}</pre>
                          </details>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                )}
              </Card>
            ))
          )}
        </div>
      </div>
    </>
  );
}
