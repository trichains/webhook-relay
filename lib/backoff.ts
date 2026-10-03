export type BackoffConfig = {
  baseMs: number;
  factor: number;
  capMs: number;
  /** 0.2 means the delay is randomized within ±20%. */
  jitter: number;
};

/** Production schedule: 30s, 2m, 8m, 32m, ~2h8m, then capped at 6h. */
export const PRODUCTION_BACKOFF: BackoffConfig = {
  baseMs: 30_000,
  factor: 4,
  capMs: 6 * 60 * 60 * 1000,
  jitter: 0.2,
};

/** Sandbox schedule (no DATABASE_URL): same idea compressed to seconds so the demo is watchable. */
export const SANDBOX_BACKOFF: BackoffConfig = {
  baseMs: 2_000,
  factor: 2,
  capMs: 60_000,
  jitter: 0.2,
};

/** Delay without jitter after `failedAttempts` (>= 1) failures. */
export function rawBackoffMs(failedAttempts: number, config: BackoffConfig): number {
  const n = Math.max(1, Math.floor(failedAttempts));
  return Math.min(config.capMs, config.baseMs * config.factor ** (n - 1));
}

/**
 * Delay before the next attempt, given how many attempts have already failed (>= 1).
 * `random` is injectable so tests are deterministic.
 */
export function backoffDelayMs(
  failedAttempts: number,
  config: BackoffConfig,
  random: () => number = Math.random,
): number {
  const raw = rawBackoffMs(failedAttempts, config);
  const spread = raw * config.jitter;
  const jittered = raw - spread + random() * spread * 2;
  return Math.round(Math.min(config.capMs, Math.max(0, jittered)));
}

/** Waits between attempts, without jitter. `maxAttempts` attempts means `maxAttempts - 1` waits. */
export function backoffSchedule(maxAttempts: number, config: BackoffConfig): number[] {
  return Array.from({ length: Math.max(0, maxAttempts - 1) }, (_, i) => rawBackoffMs(i + 1, config));
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs ? `${m}m ${rs}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}
