import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { deleteDestinationAction, deleteSourceAction, revokePreviousSecretAction, toggleDestinationAction } from "@/app/dashboard/actions";
import { DestinationForm, RotateSecretForm, SendTestWebhookButton, SourceSettingsForm } from "@/app/dashboard/_components/forms";
import { ConfirmSubmit, CopyButton, SubmitButton } from "@/components/client";
import { Badge, Card, EmptyState, formatUtc, Mono, PageHeader, SchemeBadge } from "@/components/ui";
import { env } from "@/lib/env";
import { isProtectedSource } from "@/lib/services/sources";
import { getDbHandle } from "@/lib/db/client";
import { getSource } from "@/lib/queries";
import { currentOrigin } from "@/lib/request-origin";

export const metadata = { title: "Source" };

function curlExample(scheme: string, url: string) {
  if (scheme === "hmac-sha256") {
    return `BODY='{"id":"evt_123","event":"order.paid"}'
TS=$(date +%s)
SIG=$(printf '%s' "$TS.$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')
curl -X POST '${url}' \\
  -H 'content-type: application/json' \\
  -H "x-signature: t=$TS,v1=$SIG" \\
  -d "$BODY"`;
  }
  if (scheme === "hotmart-hottok") {
    return `curl -X POST '${url}' \\
  -H 'content-type: application/json' \\
  -H "x-hotmart-hottok: $HOTTOK" \\
  -d '{"id":"6f1c…","event":"PURCHASE_APPROVED","version":"2.0.0","data":{}}'`;
  }
  return `curl -X POST '${url}' -H 'content-type: application/json' -d '{"event":"ping"}'`;
}

export default async function SourcePage({ params }: PageProps<"/dashboard/sources/[id]">) {
  await connection();
  const { id } = await params;
  const { db } = await getDbHandle();
  const data = await getSource(db, id);
  if (!data) notFound();
  const { source, destinations } = data;
  const ingestUrl = `${await currentOrigin()}/api/ingest/${source.slug}`;
  const readOnly = isProtectedSource(source.slug);
  const previousActive = !!source.previousSecret && !!source.previousSecretExpiresAt && source.previousSecretExpiresAt > new Date();

  return (
    <>
      <div className="mb-2 text-xs text-muted">
        <Link href="/dashboard/sources" className="hover:text-fg">
          ← Sources
        </Link>
      </div>
      <PageHeader
        title={source.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <SchemeBadge scheme={source.scheme} />
            <Link href={`/dashboard/events?source=${source.id}`} className="underline underline-offset-2 hover:text-fg">
              View events
            </Link>
          </span>
        }
        actions={<SendTestWebhookButton sourceId={source.id} />}
      />

      {source.scheme === "none" ? (
        <div role="alert" className="mb-4 rounded-lg border border-bad/40 bg-bad/10 px-4 py-3 text-sm text-bad">
          This source accepts any request without verifying who sent it. Anyone who knows the URL can inject events. Use it only for local testing.
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Ingest endpoint">
          <label className="label" htmlFor="ingest-url">
            POST URL
          </label>
          <div className="flex items-center gap-2">
            <input id="ingest-url" readOnly value={ingestUrl} className="input font-mono text-[12px]" data-testid="ingest-url" />
            <CopyButton value={ingestUrl} />
          </div>
          <p className="mt-3 text-xs text-muted">
            {source.scheme === "hmac-sha256"
              ? "Requires X-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of \"<t>.<raw body>\">. Timestamps older than 5 minutes are rejected."
              : source.scheme === "hotmart-hottok"
                ? "Requires the hottok in the X-HOTMART-HOTTOK header (the ?hottok= query parameter is also accepted for Hotmart v1)."
                : "No verification."}{" "}
            Send an Idempotency-Key header to control deduplication; otherwise the payload id (or a body hash) is used.
          </p>
          <details className="mt-3">
            <summary className="cursor-pointer text-xs text-muted hover:text-fg">curl example</summary>
            <pre className="mt-2 overflow-x-auto rounded bg-bg p-3 font-mono text-[11px] text-muted">{curlExample(source.scheme, ingestUrl)}</pre>
          </details>
        </Card>

        <Card title="Settings">
          <SourceSettingsForm id={source.id} name={source.name} eventTypePath={source.eventTypePath} />
          {source.scheme !== "none" ? (
            <div className="mt-4 border-t border-line pt-4">
              <div className="mb-2 text-xs text-muted">
                Secret: <Mono>{source.secret.slice(0, 4)}••••••••</Mono> (stored server-side, shown only once when generated)
              </div>
              {previousActive ? (
                <form action={revokePreviousSecretAction} className="mb-3 flex flex-wrap items-center gap-2 text-xs text-warn">
                  <input type="hidden" name="id" value={source.id} />
                  <span>
                    Previous secret <Mono>{source.previousSecret!.slice(0, 4)}••••</Mono> is still accepted until {formatUtc(source.previousSecretExpiresAt!)}.
                  </span>
                  <SubmitButton className="btn btn-sm">Revoke now</SubmitButton>
                </form>
              ) : null}
              {readOnly ? null : <RotateSecretForm id={source.id} scheme={source.scheme} />}
            </div>
          ) : null}
          {readOnly ? (
            <p className="mt-4 border-t border-line pt-4 text-xs text-muted">
              Demo source: read-only in the sandbox (no delete, no secret rotation). Create your own source to get a secret you can sign with.
            </p>
          ) : (
            <form action={deleteSourceAction} className="mt-4 border-t border-line pt-4">
              <input type="hidden" name="id" value={source.id} />
              <ConfirmSubmit message={`Delete "${source.name}" with all its destinations and events? This cannot be undone.`} className="btn btn-sm btn-danger">
                Delete source
              </ConfirmSubmit>
            </form>
          )}
        </Card>
      </div>

      <h2 className="mb-3 mt-6 text-sm font-medium">Destinations</h2>
      <div className="flex flex-col gap-3">
        {destinations.length === 0 ? (
          <Card>
            <EmptyState>No destinations yet. Events will be stored but not forwarded.</EmptyState>
          </Card>
        ) : (
          destinations.map((d) => (
            <Card
              key={d.id}
              title={
                <span className="flex items-center gap-2">
                  {d.name} {d.active ? <Badge tone="ok">active</Badge> : <Badge>paused</Badge>}
                </span>
              }
              actions={
                <>
                  <form action={toggleDestinationAction}>
                    <input type="hidden" name="id" value={d.id} />
                    <input type="hidden" name="active" value={String(!d.active)} />
                    <SubmitButton className="btn btn-sm">{d.active ? "Pause" : "Resume"}</SubmitButton>
                  </form>
                  {readOnly ? null : (
                    <form action={deleteDestinationAction}>
                      <input type="hidden" name="id" value={d.id} />
                      <ConfirmSubmit message={`Delete destination "${d.name}" and its delivery history?`} className="btn btn-sm btn-danger">
                        Delete
                      </ConfirmSubmit>
                    </form>
                  )}
                </>
              }
            >
              <DestinationForm sourceId={source.id} destination={d} sandbox={env.isSandbox} />
            </Card>
          ))
        )}
        <Card title="Add destination">
          <DestinationForm sourceId={source.id} sandbox={env.isSandbox} />
        </Card>
      </div>
    </>
  );
}
