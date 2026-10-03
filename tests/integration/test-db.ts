import { sql } from "drizzle-orm";
import { createPgHandle, createPgliteHandle, MIGRATIONS_FOLDER, type DbHandle } from "@/lib/db/client";

let migrated: Promise<void> | null = null;

/**
 * Fresh database for one test. PGlite (in memory) by default; with DATABASE_URL set the same
 * suite runs against real Postgres (CI job), which exercises the FOR UPDATE SKIP LOCKED path.
 */
export async function createTestHandle(): Promise<DbHandle> {
  const url = process.env.DATABASE_URL;
  if (!url) return createPgliteHandle();

  const handle = await createPgHandle(url);
  migrated ??= (async () => {
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: url, max: 1 });
    try {
      await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
    } finally {
      await pool.end();
    }
  })();
  await migrated;
  await handle.db.execute(sql`truncate table attempts, deliveries, events, destinations, sources cascade`);
  return handle;
}

export const driverLabel = process.env.DATABASE_URL ? "Postgres, FOR UPDATE SKIP LOCKED" : "PGlite, serialized status transition";
