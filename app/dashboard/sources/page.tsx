import Link from "next/link";
import { connection } from "next/server";
import { CreateSourceForm } from "@/app/dashboard/_components/forms";
import { Card, EmptyState, Mono, PageHeader, SchemeBadge } from "@/components/ui";
import { getDbHandle } from "@/lib/db/client";
import { listSources } from "@/lib/queries";
import { env } from "@/lib/env";

export const metadata = { title: "Sources" };

export default async function SourcesPage() {
  await connection();
  const { db } = await getDbHandle();
  const rows = await listSources(db);

  return (
    <>
      <PageHeader title="Sources" description="A source is one inbound integration (a platform account) with its own ingest URL and secret." />

      <Card padded={false} title="Sources">
        {rows.length === 0 ? (
          <EmptyState>No sources yet. Create one below.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Ingest path</th>
                  <th>Verification</th>
                  <th className="text-right">Destinations</th>
                  <th className="text-right">Events (24h)</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <Link href={`/dashboard/sources/${s.id}`} className="font-medium hover:text-accent">
                        {s.name}
                      </Link>
                    </td>
                    <td>
                      <Mono className="text-muted">/api/ingest/{s.slug}</Mono>
                    </td>
                    <td>
                      <SchemeBadge scheme={s.scheme} />
                    </td>
                    <td className="text-right tabular-nums">{s.destinationCount}</td>
                    <td className="text-right tabular-nums">{s.events24h}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="New source" className="mt-4">
        <CreateSourceForm sandbox={env.isSandbox} />
      </Card>
    </>
  );
}
