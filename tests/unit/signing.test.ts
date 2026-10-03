import { describe, expect, it } from "vitest";
import {
  activeSecrets,
  generateSecret,
  parseSignatureHeader,
  safeEqual,
  signHmac,
  verifyHmac,
  verifyHottok,
  verifyRequest,
} from "@/lib/signing";

const secret = "whsec_test_secret";
const body = JSON.stringify({ id: "evt_1", event: "order.paid", amount: 19700 });
const now = 1_790_000_000;

describe("hmac-sha256", () => {
  it("accepts a valid signature", () => {
    const header = signHmac(secret, body, now);
    expect(verifyHmac(secret, body, header, { now })).toEqual({ ok: true, reason: "valid hmac-sha256 signature" });
  });

  it("rejects a tampered body", () => {
    const header = signHmac(secret, body, now);
    const tampered = body.replace("19700", "100");
    expect(verifyHmac(secret, tampered, header, { now })).toMatchObject({ ok: false, reason: "signature mismatch" });
  });

  it("rejects a tampered timestamp (signature covers t)", () => {
    const header = signHmac(secret, body, now).replace(`t=${now}`, `t=${now + 1}`);
    expect(verifyHmac(secret, body, header, { now })).toMatchObject({ ok: false, reason: "signature mismatch" });
  });

  it("rejects an expired timestamp even with a correct signature", () => {
    const old = now - 6 * 60;
    const header = signHmac(secret, body, old);
    expect(verifyHmac(secret, body, header, { now })).toMatchObject({ ok: false });
    expect(verifyHmac(secret, body, header, { now }).reason).toContain("tolerance");
  });

  it("accepts a timestamp within the 5 minute window", () => {
    const header = signHmac(secret, body, now - 4 * 60);
    expect(verifyHmac(secret, body, header, { now }).ok).toBe(true);
  });

  it("rejects a signature made with the wrong secret", () => {
    const header = signHmac("whsec_other", body, now);
    expect(verifyHmac(secret, body, header, { now })).toMatchObject({ ok: false, reason: "signature mismatch" });
  });

  it("accepts any of several v1 values (secret rotation)", () => {
    const good = signHmac(secret, body, now).split("v1=")[1];
    const header = `t=${now},v1=${"a".repeat(64)},v1=${good}`;
    expect(verifyHmac(secret, body, header, { now }).ok).toBe(true);
  });

  it("rejects missing or malformed headers", () => {
    expect(verifyHmac(secret, body, null, { now }).reason).toContain("missing");
    expect(verifyHmac(secret, body, "v1=abc", { now }).reason).toContain("malformed");
    expect(parseSignatureHeader("t=abc,v1=x")).toBeNull();
  });
});

describe("hotmart hottok", () => {
  const hottok = "a1b2c3d4e5";

  it("accepts the token from the header", () => {
    expect(verifyHottok(hottok, hottok, null)).toEqual({ ok: true, reason: "valid hottok (header)" });
  });

  it("accepts the token from the query string (v1 compatibility)", () => {
    expect(verifyHottok(hottok, null, hottok).ok).toBe(true);
  });

  it("rejects a wrong or missing token", () => {
    expect(verifyHottok(hottok, "wrong", null)).toMatchObject({ ok: false, reason: "hottok mismatch" });
    expect(verifyHottok(hottok, null, null).ok).toBe(false);
  });

  it("works through verifyRequest with headers and URL", () => {
    const headers = new Headers({ "X-HOTMART-HOTTOK": hottok });
    const result = verifyRequest({ scheme: "hotmart-hottok", secrets: [hottok], rawBody: "{}", headers, url: new URL("http://x/api") });
    expect(result.ok).toBe(true);
    const viaQuery = verifyRequest({
      scheme: "hotmart-hottok",
      secrets: [hottok],
      rawBody: "{}",
      headers: new Headers(),
      url: new URL(`http://x/api?hottok=${hottok}`),
    });
    expect(viaQuery.ok).toBe(true);
  });
});

describe("helpers", () => {
  it("safeEqual compares strings of different length without throwing", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "a")).toBe(false);
  });

  it("scheme none always passes and is labelled as not verified", () => {
    const r = verifyRequest({ scheme: "none", secrets: [], rawBody: "{}", headers: new Headers(), url: new URL("http://x") });
    expect(r).toEqual({ ok: true, reason: "not verified (scheme: none)" });
  });

  it("generates scheme-appropriate secrets", () => {
    expect(generateSecret("hmac-sha256")).toMatch(/^whsec_[A-Za-z0-9_-]{40,}$/);
    expect(generateSecret("hotmart-hottok")).toMatch(/^[0-9a-f]{48}$/);
    expect(generateSecret("hmac-sha256")).not.toBe(generateSecret("hmac-sha256"));
  });
});

describe("secret rotation", () => {
  const rotatedAt = new Date("2026-10-01T12:00:00Z");
  const source = {
    secret: "whsec_new",
    previousSecret: "whsec_old",
    previousSecretExpiresAt: new Date(rotatedAt.getTime() + 24 * 3600_000),
  };

  it("keeps the previous secret active only during the grace period", () => {
    expect(activeSecrets(source, rotatedAt)).toEqual(["whsec_new", "whsec_old"]);
    expect(activeSecrets(source, new Date(rotatedAt.getTime() + 25 * 3600_000))).toEqual(["whsec_new"]);
    expect(activeSecrets({ secret: "s", previousSecret: null, previousSecretExpiresAt: null })).toEqual(["s"]);
  });

  it("verifies signatures made with either active secret and says which one matched", () => {
    const headersFor = (secret: string) => new Headers({ "x-signature": signHmac(secret, body, now) });
    const url = new URL("http://x/api");
    const secrets = ["whsec_new", "whsec_old"];
    expect(verifyRequest({ scheme: "hmac-sha256", secrets, rawBody: body, headers: headersFor("whsec_new"), url, now })).toEqual({
      ok: true,
      reason: "valid hmac-sha256 signature",
    });
    const old = verifyRequest({ scheme: "hmac-sha256", secrets, rawBody: body, headers: headersFor("whsec_old"), url, now });
    expect(old.ok).toBe(true);
    expect(old.reason).toContain("previous secret");
    const expired = verifyRequest({ scheme: "hmac-sha256", secrets: ["whsec_new"], rawBody: body, headers: headersFor("whsec_old"), url, now });
    expect(expired).toEqual({ ok: false, reason: "signature mismatch" });
  });

  it("works for hottok as well", () => {
    const headers = new Headers({ "x-hotmart-hottok": "old-token" });
    const r = verifyRequest({ scheme: "hotmart-hottok", secrets: ["new-token", "old-token"], rawBody: "{}", headers, url: new URL("http://x") });
    expect(r.ok).toBe(true);
  });
});
