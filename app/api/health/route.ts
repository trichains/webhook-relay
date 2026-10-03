import { sql } from "drizzle-orm";
import { getDbHandle } from "@/lib/db/client";

export async function GET() {
  try {
    const handle = await getDbHandle();
    await handle.db.execute(sql`select 1`);
    return Response.json({ ok: true, driver: handle.driver });
  } catch {
    return Response.json({ ok: false }, { status: 503 });
  }
}
