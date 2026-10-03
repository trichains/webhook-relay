/**
 * Reads the event type from a JSON payload using a dot path such as `event` or
 * `data.type`. Array indexes work too (`items.0.kind`). Returns null when the
 * value is missing or is not a string/number.
 */
export function extractEventType(payload: unknown, path = "event"): string | null {
  const segments = path
    .split(".")
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length === 0) return null;
  let current: unknown = payload;
  for (const segment of segments) {
    if (current === null || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[segment];
  }
  if (typeof current === "string" && current.trim()) return current.trim().slice(0, 120);
  if (typeof current === "number" && Number.isFinite(current)) return String(current);
  return null;
}

/** Parses a comma-separated filter. An empty list means "all events". */
export function parseEventFilter(filter: string | null | undefined): string[] {
  if (!filter) return [];
  return filter
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function matchesFilter(eventType: string | null, filter: string | null | undefined): boolean {
  const allowed = parseEventFilter(filter);
  if (allowed.length === 0) return true;
  return eventType !== null && allowed.includes(eventType);
}
