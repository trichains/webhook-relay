"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";

export function CopyButton({ value, label = "Copy", className }: { value: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={`btn btn-sm ${className ?? ""}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          setCopied(false);
        }
      }}
      aria-label={`${label} to clipboard`}
    >
      {copied ? "Copied" : label}
    </button>
  );
}

export function SubmitButton({
  children,
  pendingLabel,
  className = "btn",
  disabled,
  ...rest
}: { children: ReactNode; pendingLabel?: string; className?: string } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending || disabled} aria-busy={pending} {...rest}>
      {pending ? (pendingLabel ?? "Working…") : children}
    </button>
  );
}

/** Submit button that asks for confirmation before destructive actions. */
export function ConfirmSubmit({ children, message, className = "btn btn-danger" }: { children: ReactNode; message: string; className?: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className={className}
      disabled={pending}
      onClick={(e) => {
        if (!window.confirm(message)) e.preventDefault();
      }}
    >
      {pending ? "Working…" : children}
    </button>
  );
}

/** Re-renders the server page every few seconds while something is still in flight. */
export function AutoRefresh({ active, intervalMs = 2500 }: { active: boolean; intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs, router]);
  if (!active) return null;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted" role="status">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-info" aria-hidden />
      live, refreshing
    </span>
  );
}

export function FormMessage({ state }: { state: { ok?: boolean; message?: string; error?: string } }) {
  if (state.error) {
    return (
      <p role="alert" className="text-xs text-bad">
        {state.error}
      </p>
    );
  }
  if (state.message) {
    return (
      <p role="status" className="text-xs text-ok">
        {state.message}
      </p>
    );
  }
  return null;
}

export function FieldError({ errors, id }: { errors?: string[]; id?: string }) {
  if (!errors?.length) return null;
  return (
    <p id={id} className="mt-1 text-xs text-bad">
      {errors[0]}
    </p>
  );
}
