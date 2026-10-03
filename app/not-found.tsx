import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center px-4 py-16 text-center">
      <p className="font-mono text-xs text-muted">404</p>
      <h1 className="mt-2 text-xl font-semibold">Not found</h1>
      <p className="mt-2 text-sm text-muted">This page or record does not exist. In sandbox mode data resets when the server restarts.</p>
      <Link href="/dashboard" className="btn mt-6">
        Back to the dashboard
      </Link>
    </main>
  );
}
