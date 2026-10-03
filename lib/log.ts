type Level = "debug" | "info" | "warn" | "error";

/** Structured JSON log line: one object per line, easy to grep and to ship to a log drain. */
export function log(level: Level, event: string, fields: Record<string, unknown> = {}) {
  if (process.env.NODE_ENV === "test" && !process.env.RELAY_LOG_IN_TESTS) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
