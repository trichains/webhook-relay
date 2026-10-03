import path from "node:path";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "@/lib/db/schema";
import { env } from "@/lib/env";
import { log } from "@/lib/log";

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
export type Driver = "pg" | "pglite";

export type DbHandle = {
  db: Db;
  driver: Driver;
  close: () => Promise<void>;
};

const MIGRATIONS_FOLDER = path.join(process.cwd(), "drizzle");

/**
 * Creates a fresh in-memory PGlite database with migrations applied.
 * Used by sandbox mode (with seed data) and by the integration tests (empty).
 */
export async function createPgliteHandle(opts: { seed?: boolean } = {}): Promise<DbHandle> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  const handle: DbHandle = { db: db as unknown as Db, driver: "pglite", close: () => client.close() };
  if (opts.seed) {
    const { seedDatabase } = await import("@/lib/db/seed");
    await seedDatabase(handle.db);
  }
  return handle;
}

async function createPgHandle(url: string): Promise<DbHandle> {
  const { Pool } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const pool = new Pool({ connectionString: url, max: 5 });
  const db = drizzle(pool, { schema });
  return { db: db as unknown as Db, driver: "pg", close: () => pool.end() };
}

// Module-level singleton on globalThis: survives HMR in dev and is reused across
// requests within a warm serverless instance (important for the in-memory sandbox).
const globalForDb = globalThis as unknown as { __relayDb?: Promise<DbHandle> };

export function getDbHandle(): Promise<DbHandle> {
  if (!globalForDb.__relayDb) {
    const started = Date.now();
    const url = env.databaseUrl;
    globalForDb.__relayDb = (url ? createPgHandle(url) : createPgliteHandle({ seed: true }))
      .then((handle) => {
        log("info", "db.ready", { driver: handle.driver, ms: Date.now() - started });
        return handle;
      })
      .catch((err) => {
        globalForDb.__relayDb = undefined;
        log("error", "db.init_failed", { error: String(err) });
        throw err;
      });
  }
  return globalForDb.__relayDb;
}
