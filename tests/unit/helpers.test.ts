import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveBaseUrl } from "@/lib/env";
import { backoffDelayMs, backoffSchedule, formatDuration, PRODUCTION_BACKOFF, SANDBOX_BACKOFF } from "@/lib/backoff";
import { extractEventType, matchesFilter, parseEventFilter } from "@/lib/event-type";
import { deriveIdempotencyKey } from "@/lib/idempotency";
import { percentile, successRate } from "@/lib/stats";
import { computeEventStatus, isRetryableStatus, resolveTargetUrl } from "@/lib/services/delivery";
import { healthLabel } from "@/lib/queries";
import { isProtectedSource } from "@/lib/services/sources";

describe("backoff", () => {
  it("follows base 30s, factor 4, capped at 6h", () => {
    expect(backoffSchedule(6, PRODUCTION_BACKOFF)).toEqual([30_000, 120_000, 480_000, 1_920_000, 7_680_000]);
    expect(backoffSchedule(8, PRODUCTION_BACKOFF).slice(-2)).toEqual([6 * 3600_000, 6 * 3600_000]);
  });

  it("applies ±20% jitter around the raw delay", () => {
    expect(backoffDelayMs(1, PRODUCTION_BACKOFF, () => 0)).toBe(24_000);
    expect(backoffDelayMs(1, PRODUCTION_BACKOFF, () => 0.5)).toBe(30_000);
    expect(backoffDelayMs(1, PRODUCTION_BACKOFF, () => 0.999999)).toBe(36_000);
  });

  it("never exceeds the cap, even with jitter", () => {
    expect(backoffDelayMs(20, PRODUCTION_BACKOFF, () => 0.999999)).toBe(PRODUCTION_BACKOFF.capMs);
  });

  it("treats invalid attempt counts as the first retry", () => {
    expect(backoffDelayMs(0, PRODUCTION_BACKOFF, () => 0.5)).toBe(30_000);
  });

  it("sandbox schedule is in seconds", () => {
    expect(backoffSchedule(6, SANDBOX_BACKOFF)).toEqual([2_000, 4_000, 8_000, 16_000, 32_000]);
  });

  it("formats durations", () => {
    expect(formatDuration(450)).toBe("450ms");
    expect(formatDuration(30_000)).toBe("30s");
    expect(formatDuration(7_680_000)).toBe("2h 8m");
  });
});

describe("idempotency key", () => {
  const base = { sourceId: "src_1", rawBody: '{"id":"abc","event":"PURCHASE_APPROVED"}' };

  it("prefers the Idempotency-Key header", () => {
    expect(deriveIdempotencyKey({ ...base, headerValue: " key-123 ", payload: { id: "abc" } })).toEqual({
      key: "key-123",
      strategy: "header",
    });
  });

  it("falls back to the payload id (Hotmart)", () => {
    expect(deriveIdempotencyKey({ ...base, headerValue: null, payload: { id: "abc" } })).toEqual({
      key: "abc",
      strategy: "payload-id",
    });
    expect(deriveIdempotencyKey({ ...base, headerValue: "", payload: { id: 42 } }).key).toBe("42");
  });

  it("falls back to a sha256 of source + body", () => {
    const a = deriveIdempotencyKey({ ...base, headerValue: null, payload: { event: "x" } });
    const b = deriveIdempotencyKey({ ...base, sourceId: "src_2", headerValue: null, payload: { event: "x" } });
    expect(a.strategy).toBe("body-hash");
    expect(a.key).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a.key).not.toBe(b.key);
    expect(deriveIdempotencyKey({ ...base, headerValue: null, payload: { event: "x" } }).key).toBe(a.key);
  });

  it("ignores empty or non-scalar ids", () => {
    expect(deriveIdempotencyKey({ ...base, headerValue: null, payload: { id: "  " } }).strategy).toBe("body-hash");
    expect(deriveIdempotencyKey({ ...base, headerValue: null, payload: { id: { nested: 1 } } }).strategy).toBe("body-hash");
    expect(deriveIdempotencyKey({ ...base, headerValue: null, payload: [1, 2] }).strategy).toBe("body-hash");
  });
});

describe("event type extraction", () => {
  it("reads the default `event` field", () => {
    expect(extractEventType({ event: "PURCHASE_APPROVED" })).toBe("PURCHASE_APPROVED");
  });

  it("supports dot paths and array indexes", () => {
    expect(extractEventType({ data: { type: "invoice.paid" } }, "data.type")).toBe("invoice.paid");
    expect(extractEventType({ items: [{ kind: "refund" }] }, "items.0.kind")).toBe("refund");
  });

  it("returns null for missing or non-scalar values", () => {
    expect(extractEventType({}, "event")).toBeNull();
    expect(extractEventType({ event: { a: 1 } })).toBeNull();
    expect(extractEventType(null)).toBeNull();
    expect(extractEventType({ event: "x" }, "")).toBeNull();
  });

  it("matches comma-separated filters", () => {
    expect(parseEventFilter(" A, B ,,C ")).toEqual(["A", "B", "C"]);
    expect(matchesFilter("A", "A,B")).toBe(true);
    expect(matchesFilter("C", "A,B")).toBe(false);
    expect(matchesFilter(null, "A")).toBe(false);
    expect(matchesFilter(null, "")).toBe(true);
  });
});

describe("stats", () => {
  it("computes nearest-rank percentiles", () => {
    const values = [100, 20, 30, 40, 50, 60, 70, 80, 90, 10];
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 95)).toBe(100);
    expect(percentile(values, 0)).toBe(10);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 50)).toBeNull();
  });

  it("does not mutate the input", () => {
    const values = [3, 1, 2];
    percentile(values, 50);
    expect(values).toEqual([3, 1, 2]);
  });

  it("computes success rate", () => {
    expect(successRate(3, 4)).toBe(0.75);
    expect(successRate(0, 0)).toBeNull();
  });

  it("labels destination health", () => {
    expect(healthLabel(false, 1, 10)).toBe("paused");
    expect(healthLabel(true, null, 0)).toBe("no data");
    expect(healthLabel(true, 0.99, 10)).toBe("healthy");
    expect(healthLabel(true, 0.6, 10)).toBe("degraded");
    expect(healthLabel(true, 0.1, 10)).toBe("failing");
  });
});

describe("delivery rules", () => {
  it("does not retry permanent 4xx errors", () => {
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(408)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(null)).toBe(true);
  });

  it("aggregates delivery statuses into an event status", () => {
    expect(computeEventStatus([])).toBe("no_destinations");
    expect(computeEventStatus(["succeeded", "pending"])).toBe("pending");
    expect(computeEventStatus(["succeeded", "dead_letter"])).toBe("dead_letter");
    expect(computeEventStatus(["succeeded", "succeeded"])).toBe("delivered");
  });

  it("resolves built-in sink paths against the base URL", () => {
    expect(resolveTargetUrl("/api/sink/ok", "http://localhost:3101/")).toBe("http://localhost:3101/api/sink/ok");
    expect(resolveTargetUrl("https://example.com/hook", "http://x")).toBe("https://example.com/hook");
  });
});


describe("sandbox protections", () => {
  it("treats the seeded demo sources as read-only only in sandbox mode", () => {
    expect(isProtectedSource("hotmart", true)).toBe(true);
    expect(isProtectedSource("store-checkout", true)).toBe(true);
    expect(isProtectedSource("my-source", true)).toBe(false);
    expect(isProtectedSource("hotmart", false)).toBe(false);
  });

  it("does not retry redirects", () => {
    expect(isRetryableStatus(301)).toBe(false);
    expect(isRetryableStatus(302)).toBe(false);
  });
});

describe("base URL precedence", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("prefers configured URLs over the client-controlled request origin", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://relay.example.com/");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "webhook-relay-gray.vercel.app");
    expect(resolveBaseUrl("https://evil.example")).toBe("https://relay.example.com");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    expect(resolveBaseUrl("https://evil.example")).toBe("https://webhook-relay-gray.vercel.app");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "");
    expect(resolveBaseUrl("http://localhost:3101")).toBe("http://localhost:3101");
  });
});
