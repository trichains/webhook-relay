/** Nearest-rank percentile (p in 0..100). Returns null for an empty list. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const clamped = Math.min(100, Math.max(0, p));
  const rank = Math.ceil((clamped / 100) * sorted.length);
  return sorted[Math.max(0, rank - 1)];
}

/** Ratio in 0..1, or null when there is nothing to measure. */
export function successRate(ok: number, total: number): number | null {
  if (total <= 0) return null;
  return ok / total;
}
