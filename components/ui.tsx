import Link from "next/link";
import type { ReactNode } from "react";
import type { DeliveryStatus, EventStatus, SigningScheme } from "@/lib/db/schema";

export function cx(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(" ");
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Card({ title, actions, children, className, padded = true }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; padded?: boolean }) {
  return (
    <section className={cx("rounded-lg border border-line bg-surface", className)}>
      {title || actions ? (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5">
          <h2 className="text-sm font-medium">{title}</h2>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div className={padded ? "p-4" : undefined}>{children}</div>
    </section>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "ok" | "warn" | "bad" }) {
  const toneClass = tone === "ok" ? "text-ok" : tone === "warn" ? "text-warn" : tone === "bad" ? "text-bad" : "text-fg";
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3">
      <div className="text-xs text-muted">{label}</div>
      <div className={cx("mt-1 text-2xl font-semibold tabular-nums tracking-tight", toneClass)}>{value}</div>
      {hint ? <div className="mt-0.5 text-xs text-faint">{hint}</div> : null}
    </div>
  );
}

type Tone = "ok" | "warn" | "bad" | "info" | "neutral" | "accent";

const TONE_CLASSES: Record<Tone, string> = {
  ok: "border-ok/30 bg-ok/10 text-ok",
  warn: "border-warn/30 bg-warn/10 text-warn",
  bad: "border-bad/30 bg-bad/10 text-bad",
  info: "border-info/30 bg-info/10 text-info",
  neutral: "border-line-strong bg-surface-2 text-muted",
  accent: "border-accent/40 bg-accent/10 text-accent",
};

export function Badge({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={cx("inline-flex items-center whitespace-nowrap rounded border px-1.5 py-0.5 text-[11px] font-medium leading-none", TONE_CLASSES[tone])}
    >
      {children}
    </span>
  );
}

const EVENT_STATUS: Record<EventStatus, { tone: Tone; label: string }> = {
  delivered: { tone: "ok", label: "delivered" },
  pending: { tone: "info", label: "pending" },
  dead_letter: { tone: "bad", label: "dead letter" },
  rejected: { tone: "warn", label: "rejected" },
  no_destinations: { tone: "neutral", label: "no destinations" },
};

export function EventStatusBadge({ status }: { status: EventStatus }) {
  const s = EVENT_STATUS[status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export function DeliveryStatusBadge({ status, attemptCount }: { status: DeliveryStatus; attemptCount: number }) {
  if (status === "succeeded") return <Badge tone="ok">succeeded</Badge>;
  if (status === "dead_letter") return <Badge tone="bad">dead letter</Badge>;
  if (status === "processing") return <Badge tone="info">in flight</Badge>;
  return <Badge tone={attemptCount > 0 ? "warn" : "info"}>{attemptCount > 0 ? "retrying" : "queued"}</Badge>;
}

export function SchemeBadge({ scheme }: { scheme: SigningScheme }) {
  if (scheme === "none") {
    return (
      <Badge tone="bad" title="Requests are accepted without any signature check">
        no verification
      </Badge>
    );
  }
  return <Badge tone="neutral">{scheme}</Badge>;
}

export function SandboxBadge() {
  return (
    <Badge tone="accent" title="No DATABASE_URL configured: PGlite runs in memory with seeded demo data">
      Sandbox<span className="hidden sm:inline">: in-memory data, resets on cold start</span>
    </Badge>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="px-4 py-10 text-center text-sm text-muted">{children}</div>;
}

export function TextLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <Link href={href} className={cx("text-fg underline decoration-line-strong underline-offset-2 hover:decoration-accent", className)}>
      {children}
    </Link>
  );
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx("font-mono text-[12px]", className)}>{children}</span>;
}

export function relativeTime(date: Date, now = new Date()): string {
  const diff = now.getTime() - date.getTime();
  const future = diff < 0;
  const s = Math.round(Math.abs(diff) / 1000);
  let text: string;
  if (s < 5) return future ? "in a moment" : "just now";
  if (s < 60) text = `${s}s`;
  else if (s < 3600) text = `${Math.floor(s / 60)}m`;
  else if (s < 86400) text = `${Math.floor(s / 3600)}h`;
  else text = `${Math.floor(s / 86400)}d`;
  return future ? `in ${text}` : `${text} ago`;
}

export function formatUtc(date: Date): string {
  return `${date.toISOString().replace("T", " ").slice(0, 19)} UTC`;
}

export function Time({ date }: { date: Date }) {
  return (
    <time dateTime={date.toISOString()} title={formatUtc(date)} className="whitespace-nowrap text-muted">
      {relativeTime(date)}
    </time>
  );
}

export function formatMs(ms: number | null): string {
  if (ms === null) return "–";
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`;
}

export function formatPercent(rate: number | null): string {
  if (rate === null) return "–";
  return `${(rate * 100).toFixed(rate === 1 ? 0 : 1)}%`;
}
