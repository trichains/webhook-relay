// One-shot migration job for self-hosting (compose service `migrate`).
// Applies ./drizzle with drizzle-orm's node-postgres migrator, under a Postgres advisory lock so
// two concurrent deploys can never run the same migration twice.
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const LOCK_ID = 727274001; // arbitrary, constant
const log = (level, event, fields = {}) =>
  console[level === "error" ? "error" : "log"](JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields }));

const url = process.env.DATABASE_URL;
if (!url) {
  log("error", "migrate.no_database_url");
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: url, max: 2 });

async function connectWithRetry(attempts = 30) {
  for (let i = 1; ; i++) {
    try {
      return await pool.connect();
    } catch (err) {
      if (i >= attempts) throw err;
      log("warn", "migrate.waiting_for_db", { attempt: i, error: String(err.message ?? err) });
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

const started = Date.now();
try {
  const lock = await connectWithRetry();
  try {
    await lock.query("select pg_advisory_lock($1)", [LOCK_ID]);
    await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
    await lock.query("select pg_advisory_unlock($1)", [LOCK_ID]);
  } finally {
    lock.release();
  }
  log("info", "migrate.done", { ms: Date.now() - started });
} catch (err) {
  log("error", "migrate.failed", { error: String(err?.message ?? err) });
  process.exitCode = 1;
} finally {
  await pool.end();
}
