"use client";

import Link from "next/link";
import { useActionState, useId } from "react";
import {
  createDestinationAction,
  createSourceAction,
  processQueueAction,
  replayEventAction,
  retryDeadLettersAction,
  rotateSecretAction,
  sendTestWebhookAction,
  updateDestinationAction,
  updateSourceAction,
  type ActionState,
} from "@/app/dashboard/actions";
import { CopyButton, FieldError, FormMessage, SubmitButton } from "@/components/client";
import type { Destination, SigningScheme } from "@/lib/db/schema";

const initial: ActionState = {};

function SecretPanel({ secret, scheme }: { secret: string; scheme?: SigningScheme }) {
  return (
    <div className="mt-3 rounded-md border border-accent/40 bg-accent/5 p-3">
      <p className="text-xs font-medium text-accent">Copy this secret now. It will not be shown again.</p>
      <div className="mt-2 flex items-center gap-2">
        <code className="min-w-0 flex-1 overflow-x-auto rounded bg-bg px-2 py-1.5 font-mono text-[12px]" data-testid="secret-value">
          {secret}
        </code>
        <CopyButton value={secret} />
      </div>
      {scheme === "hotmart-hottok" ? (
        <p className="mt-2 text-xs text-muted">Paste it as the hottok in Hotmart. It is sent in the X-HOTMART-HOTTOK header.</p>
      ) : scheme === "hmac-sha256" ? (
        <p className="mt-2 text-xs text-muted">Senders sign with HMAC-SHA256 over &quot;&lt;timestamp&gt;.&lt;raw body&gt;&quot; using this secret.</p>
      ) : null}
    </div>
  );
}

export function ProcessQueueButton() {
  const [state, action] = useActionState(processQueueAction, initial);
  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <FormMessage state={state} />
      <SubmitButton pendingLabel="Processing…">Process queue now</SubmitButton>
    </form>
  );
}

export function SendTestWebhookButton({ sourceId }: { sourceId: string }) {
  const [state, action] = useActionState(sendTestWebhookAction, initial);
  return (
    <form action={action} className="flex flex-col items-start gap-2">
      <input type="hidden" name="id" value={sourceId} />
      <SubmitButton className="btn btn-primary" pendingLabel="Sending…">
        Send test webhook
      </SubmitButton>
      <FormMessage state={state} />
      {state.eventId ? (
        <Link href={`/dashboard/events/${state.eventId}`} className="text-xs text-accent underline underline-offset-2" data-testid="test-event-link">
          Open the event →
        </Link>
      ) : null}
    </form>
  );
}

export function CreateSourceForm() {
  const [state, action] = useActionState(createSourceAction, initial);
  const id = useId();
  const v = state.values ?? {};
  const fe = state.fieldErrors ?? {};
  return (
    <div>
      <form action={action} className="grid gap-3 sm:grid-cols-2" noValidate>
        <div>
          <label className="label" htmlFor={`${id}-name`}>
            Name
          </label>
          <input id={`${id}-name`} name="name" className="input" placeholder="Hotmart production" defaultValue={v.name} aria-invalid={!!fe.name} required />
          <FieldError errors={fe.name} />
        </div>
        <div>
          <label className="label" htmlFor={`${id}-slug`}>
            Slug <span className="text-faint">(optional, used in the ingest URL)</span>
          </label>
          <input id={`${id}-slug`} name="slug" className="input font-mono" placeholder="hotmart-prod" defaultValue={v.slug} aria-invalid={!!fe.slug} />
          <FieldError errors={fe.slug} />
        </div>
        <div>
          <label className="label" htmlFor={`${id}-scheme`}>
            Signing scheme
          </label>
          <select id={`${id}-scheme`} name="scheme" className="input" defaultValue={v.scheme ?? "hmac-sha256"}>
            <option value="hmac-sha256">hmac-sha256 (X-Signature: t=…,v1=…)</option>
            <option value="hotmart-hottok">hotmart-hottok (X-HOTMART-HOTTOK)</option>
            <option value="none">none (insecure, accepts anything)</option>
          </select>
          <FieldError errors={fe.scheme} />
        </div>
        <div>
          <label className="label" htmlFor={`${id}-path`}>
            Event type path
          </label>
          <input id={`${id}-path`} name="eventTypePath" className="input font-mono" placeholder="event" defaultValue={v.eventTypePath} aria-invalid={!!fe.eventTypePath} />
          <FieldError errors={fe.eventTypePath} />
        </div>
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
          <SubmitButton className="btn btn-primary" pendingLabel="Creating…">
            Create source
          </SubmitButton>
          <FormMessage state={state} />
        </div>
      </form>
      {state.ok && state.secret ? (
        <>
          <SecretPanel secret={state.secret} />
          {state.sourceId ? (
            <Link href={`/dashboard/sources/${state.sourceId}`} className="mt-2 inline-block text-xs text-accent underline underline-offset-2">
              Open the new source →
            </Link>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

export function SourceSettingsForm({ id, name, eventTypePath }: { id: string; name: string; eventTypePath: string }) {
  const [state, action] = useActionState(updateSourceAction, initial);
  const uid = useId();
  const fe = state.fieldErrors ?? {};
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-start" noValidate>
      <input type="hidden" name="id" value={id} />
      <div>
        <label className="label" htmlFor={`${uid}-name`}>
          Name
        </label>
        <input id={`${uid}-name`} name="name" className="input" defaultValue={state.values?.name ?? name} aria-invalid={!!fe.name} />
        <FieldError errors={fe.name} />
      </div>
      <div>
        <label className="label" htmlFor={`${uid}-path`}>
          Event type path
        </label>
        <input id={`${uid}-path`} name="eventTypePath" className="input font-mono" defaultValue={state.values?.eventTypePath ?? eventTypePath} aria-invalid={!!fe.eventTypePath} />
        <FieldError errors={fe.eventTypePath} />
      </div>
      <div className="flex items-center gap-3 sm:pt-5">
        <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
        <FormMessage state={state} />
      </div>
    </form>
  );
}

export function RotateSecretForm({ id, scheme }: { id: string; scheme: SigningScheme }) {
  const [state, action] = useActionState(rotateSecretAction, initial);
  return (
    <div>
      <form
        action={action}
        className="flex flex-wrap items-center gap-3"
        onSubmit={(e) => {
          if (!window.confirm("Generate a new secret? Senders using the current one will be rejected.")) e.preventDefault();
        }}
      >
        <input type="hidden" name="id" value={id} />
        <SubmitButton pendingLabel="Rotating…">Rotate secret</SubmitButton>
        {!state.secret ? <FormMessage state={state} /> : null}
      </form>
      {state.secret ? <SecretPanel secret={state.secret} scheme={scheme} /> : null}
    </div>
  );
}

export function DestinationForm({ sourceId, destination }: { sourceId: string; destination?: Destination }) {
  const [state, action] = useActionState(destination ? updateDestinationAction : createDestinationAction, initial);
  const uid = useId();
  const fe = state.fieldErrors ?? {};
  const v = state.ok ? {} : (state.values ?? {});
  const d = destination;
  const activeDefault = v.active !== undefined ? v.active === "on" : (d?.active ?? true);
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-6" noValidate>
      <input type="hidden" name="sourceId" value={sourceId} />
      {d ? <input type="hidden" name="id" value={d.id} /> : null}
      <div className="sm:col-span-2">
        <label className="label" htmlFor={`${uid}-name`}>
          Name
        </label>
        <input id={`${uid}-name`} name="name" className="input" placeholder="Member area" defaultValue={v.name ?? d?.name} aria-invalid={!!fe.name} />
        <FieldError errors={fe.name} />
      </div>
      <div className="sm:col-span-4">
        <label className="label" htmlFor={`${uid}-url`}>
          URL
        </label>
        <input
          id={`${uid}-url`}
          name="url"
          className="input font-mono"
          placeholder="https://api.example.com/webhooks or /api/sink/ok"
          defaultValue={v.url ?? d?.url}
          aria-invalid={!!fe.url}
          list={`${uid}-sinks`}
        />
        <datalist id={`${uid}-sinks`}>
          <option value="/api/sink/ok" />
          <option value="/api/sink/flaky" />
          <option value="/api/sink/slow" />
          <option value="/api/sink/fail" />
          <option value="/api/sink/reject" />
        </datalist>
        <FieldError errors={fe.url} />
      </div>
      <div className="sm:col-span-3">
        <label className="label" htmlFor={`${uid}-filter`}>
          Event filter <span className="text-faint">(comma-separated, empty = all)</span>
        </label>
        <input
          id={`${uid}-filter`}
          name="eventFilter"
          className="input font-mono"
          placeholder="PURCHASE_APPROVED, PURCHASE_COMPLETE"
          defaultValue={v.eventFilter ?? d?.eventFilter ?? ""}
          aria-invalid={!!fe.eventFilter}
        />
        <FieldError errors={fe.eventFilter} />
      </div>
      <div>
        <label className="label" htmlFor={`${uid}-max`}>
          Max attempts
        </label>
        <input id={`${uid}-max`} name="maxAttempts" type="number" min={1} max={12} className="input" defaultValue={v.maxAttempts ?? d?.maxAttempts ?? 6} aria-invalid={!!fe.maxAttempts} />
        <FieldError errors={fe.maxAttempts} />
      </div>
      <div>
        <label className="label" htmlFor={`${uid}-timeout`}>
          Timeout (ms)
        </label>
        <input id={`${uid}-timeout`} name="timeoutMs" type="number" min={1000} max={30000} step={500} className="input" defaultValue={v.timeoutMs ?? d?.timeoutMs ?? 10000} aria-invalid={!!fe.timeoutMs} />
        <FieldError errors={fe.timeoutMs} />
      </div>
      <div className="flex items-end pb-2">
        <label className="inline-flex items-center gap-2 text-sm">
          <input type="checkbox" name="active" defaultChecked={activeDefault} className="h-4 w-4 accent-accent" />
          Active
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-3 sm:col-span-6">
        <SubmitButton className={d ? "btn" : "btn btn-primary"} pendingLabel="Saving…">
          {d ? "Save destination" : "Add destination"}
        </SubmitButton>
        <FormMessage state={state} />
      </div>
    </form>
  );
}

export function ReplayForm({
  eventId,
  destinations,
  compact = false,
}: {
  eventId: string;
  destinations: { id: string; name: string; active: boolean }[];
  compact?: boolean;
}) {
  const [state, action] = useActionState(replayEventAction, initial);
  const uid = useId();
  if (compact) {
    return (
      <form action={action} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="eventId" value={eventId} />
        <input type="hidden" name="destinationId" value={destinations[0]?.id ?? ""} />
        <SubmitButton className="btn btn-sm" pendingLabel="Replaying…">
          Replay
        </SubmitButton>
        <FormMessage state={state} />
      </form>
    );
  }
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="eventId" value={eventId} />
      <div>
        <label className="label" htmlFor={`${uid}-dest`}>
          Replay to
        </label>
        <select id={`${uid}-dest`} name="destinationId" className="input min-w-52" defaultValue="">
          <option value="">All matching destinations</option>
          {destinations.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
              {d.active ? "" : " (paused)"}
            </option>
          ))}
        </select>
      </div>
      <SubmitButton pendingLabel="Replaying…">Replay</SubmitButton>
      <div className="basis-full">
        <FormMessage state={state} />
      </div>
    </form>
  );
}

export function RetryDeadLettersButton({ destinationId, count }: { destinationId: string; count: number }) {
  const [state, action] = useActionState(retryDeadLettersAction, initial);
  // Stays mounted after the count drops to 0 so the confirmation message remains visible.
  if (count === 0 && !state.message && !state.error) return null;
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="destinationId" value={destinationId} />
      <SubmitButton className="btn btn-sm" pendingLabel="Queuing…" disabled={count === 0}>
        Retry all dead letters ({count})
      </SubmitButton>
      <FormMessage state={state} />
    </form>
  );
}
