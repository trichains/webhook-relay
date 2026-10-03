import Link from "next/link";
import { DashboardNav } from "@/app/dashboard/_components/nav";
import { SandboxBadge } from "@/components/ui";
import { env } from "@/lib/env";

export const metadata = { title: "Dashboard" };

export default function DashboardLayout({ children }: LayoutProps<"/dashboard">) {
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2 px-4 pt-3">
          <div className="flex min-w-0 items-center gap-3">
            <Link href="/" className="flex items-center gap-2 whitespace-nowrap font-semibold tracking-tight">
              <svg viewBox="0 0 32 32" className="h-5 w-5" aria-hidden>
                <path d="M7 11h9l-3-3M25 21h-9l3 3" fill="none" stroke="#f2884b" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                <circle cx="16" cy="16" r="2.5" fill="currentColor" />
              </svg>
              webhook-relay
            </Link>
            {env.isSandbox ? <SandboxBadge /> : null}
          </div>
          <a href="https://github.com/trichains/webhook-relay" className="text-xs text-muted hover:text-fg" target="_blank" rel="noreferrer">
            GitHub
          </a>
        </div>
        <div className="mx-auto max-w-7xl px-4 pt-2">
          <DashboardNav />
        </div>
      </header>
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">{children}</main>
    </div>
  );
}
