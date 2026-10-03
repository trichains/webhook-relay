import Link from "next/link";
import { SandboxBadge } from "@/components/ui";
import { backoffSchedule, formatDuration, PRODUCTION_BACKOFF } from "@/lib/backoff";
import { env } from "@/lib/env";

const STEPS = [
  ["Verify", "HMAC-SHA256 with a 5 minute timestamp window, or the Hotmart hottok. Constant-time compare."],
  ["Deduplicate", "Idempotency-Key header, else the payload id, else a body hash. A repeat gets 200 and is not delivered again."],
  ["Store", "Raw payload, selected headers, verification result and event type go to Postgres before the 202."],
  ["Deliver", "One delivery per matching destination, first attempt right after the response with after()."],
  ["Retry", `Exponential backoff with jitter: ${backoffSchedule(6, PRODUCTION_BACKOFF).map(formatDuration).join(", ")}.`],
  ["Dead-letter & replay", "Failed deliveries land in a queue you can inspect and replay, one event or a whole destination."],
];

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center px-4 py-16">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-muted">trichains/webhook-relay</span>
        {env.isSandbox ? <SandboxBadge /> : null}
      </div>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">Webhook Relay</h1>
      <p className="mt-4 text-base leading-relaxed text-muted">
        A webhook gateway for payment and sales platforms like Hotmart or Stripe-style checkouts. It sits between the platform and your apps: it
        checks signatures, makes sure the same event is never processed twice, keeps retrying when your receiver is down, and keeps a searchable
        log you can replay from.
      </p>
      <div className="mt-6 flex flex-wrap gap-3">
        <Link href="/dashboard" className="btn btn-primary">
          Open the dashboard
        </Link>
        <a href="https://github.com/trichains/webhook-relay" className="btn" target="_blank" rel="noreferrer">
          Source on GitHub
        </a>
      </div>

      <ol className="mt-12 grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-2">
        {STEPS.map(([title, text], i) => (
          <li key={title} className="bg-surface p-4">
            <div className="text-xs text-faint">{String(i + 1).padStart(2, "0")}</div>
            <div className="mt-1 text-sm font-medium">{title}</div>
            <p className="mt-1 text-sm leading-relaxed text-muted">{text}</p>
          </li>
        ))}
      </ol>

      <p className="mt-8 text-xs text-faint">
        {env.isSandbox
          ? "This demo runs without a database: PGlite (Postgres compiled to WASM) runs in memory with seeded data, and retries are compressed to seconds so you can watch them."
          : "Running against Postgres."}{" "}
        Built by{" "}
        <a href="https://trichains.dev" className="underline underline-offset-2 hover:text-muted">
          Cristhian Almeida
        </a>
        .
      </p>
    </main>
  );
}
