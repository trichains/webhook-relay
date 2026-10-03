import { describe, expect, it } from "vitest";
import { checkOutboundUrl, isBlockedIp, isPrivateHostname, normalizeHost, validateDestinationUrl } from "@/lib/ssrf";

const REAL = { sandbox: false, allowPrivate: false };
const SANDBOX = { sandbox: true, allowPrivate: false };
const publicLookup = async () => ["93.184.216.34"];

describe("sandbox policy", () => {
  it("accepts only the built-in sinks", () => {
    for (const kind of ["ok", "fail", "flaky", "slow", "reject"]) {
      expect(validateDestinationUrl(`/api/sink/${kind}`, SANDBOX)).toBeNull();
    }
    expect(validateDestinationUrl("https://api.example.com/hooks", SANDBOX)).toMatch(/only delivers to the built-in sinks/);
    expect(validateDestinationUrl("/api/sink/nope", SANDBOX)).toMatch(/built-in sink/);
    expect(validateDestinationUrl("/api/v1/events", SANDBOX)).toMatch(/built-in sink/);
  });

  it("blocks external URLs right before the attempt too", async () => {
    expect(await checkOutboundUrl("https://api.example.com/hooks", SANDBOX, publicLookup)).toEqual({
      error: "blocked: sandbox only delivers to built-in sinks",
      permanent: true,
    });
    expect(await checkOutboundUrl("/api/sink/ok", SANDBOX)).toBeNull();
  });
});

describe("real mode: literal hosts", () => {
  it("accepts public URLs", () => {
    expect(validateDestinationUrl("https://api.example.com/hooks", REAL)).toBeNull();
    expect(validateDestinationUrl("http://93.184.216.34/hook", REAL)).toBeNull();
  });

  it("rejects bad schemes and credentials", () => {
    expect(validateDestinationUrl("ftp://example.com", REAL)).toMatch(/http/);
    expect(validateDestinationUrl("https://user:pw@example.com", REAL)).toMatch(/Credentials/);
  });

  it.each([
    ["loopback", "http://127.0.0.1/"],
    ["loopback range", "http://127.8.9.10/"],
    ["localhost", "http://localhost:3000/"],
    ["localhost with trailing dot", "http://localhost./"],
    ["subdomain of localhost", "http://api.localhost/"],
    ["RFC 1918 10/8", "http://10.0.0.5/"],
    ["RFC 1918 172.16/12", "http://172.20.1.1/"],
    ["RFC 1918 192.168/16", "http://192.168.1.2/"],
    ["link-local / metadata", "http://169.254.169.254/latest/meta-data"],
    ["CGNAT 100.64/10", "http://100.64.0.1/"],
    ["CGNAT upper edge", "http://100.127.255.254/"],
    ["0.0.0.0", "http://0.0.0.0/"],
    ["decimal integer IPv4 (normalized by URL)", "http://2130706433/"],
    ["hex IPv4 (normalized by URL)", "http://0x7f000001/"],
    ["IPv6 loopback", "http://[::1]/"],
    ["IPv6 unspecified", "http://[::]/"],
    ["IPv4-mapped IPv6 loopback", "http://[::ffff:127.0.0.1]/"],
    ["IPv4-mapped IPv6 metadata", "http://[::ffff:169.254.169.254]/"],
    ["IPv6 unique local", "http://[fd00::1]/"],
    ["IPv6 link-local", "http://[fe80::1]/"],
    ["mDNS name", "http://printer.local/"],
    ["internal name", "http://metadata.google.internal/"],
  ])("rejects %s (%s)", (_label, url) => {
    expect(validateDestinationUrl(url, REAL)).toMatch(/Private, loopback and reserved/);
  });

  it("does not block 100.63.x or 100.128.x (outside CGNAT)", () => {
    expect(isBlockedIp("100.63.255.255")).toBe(false);
    expect(isBlockedIp("100.128.0.1")).toBe(false);
  });

  it("allows private hosts only when explicitly enabled (local development)", () => {
    expect(validateDestinationUrl("http://localhost:4000/hook", { sandbox: false, allowPrivate: true })).toBeNull();
  });

  it("normalizes hostnames", () => {
    expect(normalizeHost("LocalHost.")).toBe("localhost");
    expect(normalizeHost("[::1]")).toBe("::1");
    expect(isPrivateHostname("")).toBe(true);
  });
});

describe("real mode: resolved addresses", () => {
  it("passes when every resolved address is public", async () => {
    expect(await checkOutboundUrl("https://api.example.com/hook", REAL, publicLookup)).toBeNull();
  });

  it.each([
    ["IPv4 private", ["10.1.2.3"]],
    ["IPv4 loopback among public answers", ["93.184.216.34", "127.0.0.1"]],
    ["IPv6 loopback", ["::1"]],
    ["IPv4-mapped IPv6 (dotted)", ["::ffff:10.0.0.1"]],
    ["IPv4-mapped IPv6 (hex)", ["::ffff:a00:1"]],
    ["CGNAT", ["100.100.100.200"]],
    ["unique local IPv6", ["fd12:3456::1"]],
  ])("blocks a public name that resolves to %s", async (_label, addresses) => {
    const result = await checkOutboundUrl("https://rebind.example.com/hook", REAL, async () => addresses);
    expect(result?.permanent).toBe(true);
    expect(result?.error).toMatch(/resolves to a private or reserved address/);
  });

  it("treats DNS failures as transient", async () => {
    const result = await checkOutboundUrl("https://nx.example.com/hook", REAL, async () => {
      throw new Error("ENOTFOUND");
    });
    expect(result).toEqual({ error: "dns lookup failed: ENOTFOUND", permanent: false });
  });

  it("checks literal IPs without DNS", async () => {
    expect(await checkOutboundUrl("http://[::ffff:7f00:1]/", REAL)).toMatchObject({ permanent: true });
  });
});
