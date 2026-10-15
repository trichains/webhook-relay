import { sql } from "drizzle-orm";
import { getDbHandle } from "@/lib/db/client";
import { env } from "@/lib/env";

export async function GET() {
  try {
    const handle = await getDbHandle();
    await handle.db.execute(sql`select 1`);
    return Response.json({ ok: true, driver: handle.driver, ...(env.appVersion ? { version: env.appVersion } : {}) });
  } catch {
    return Response.json({ ok: false, ...(env.appVersion ? { version: env.appVersion } : {}) }, { status: 503 });
  }
}
