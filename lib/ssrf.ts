import { BlockList, isIP } from "node:net";
import { isSinkKind } from "@/lib/sinks";

/**
 * Outbound URL policy.
 * - sandbox: only the built-in `/api/sink/<kind>` receivers. The public demo must not be an
 *   anonymous HTTP relay that shows the response body of arbitrary URLs.
 * - real mode: absolute http(s) URLs whose host is not loopback/private/link-local/CGNAT/etc.,
 *   checked on the literal host when saving and again on the resolved IPs before every attempt.
 */

const blocked = new BlockList();
// IPv4
blocked.addSubnet("0.0.0.0", 8, "ipv4"); // "this" network, includes 0.0.0.0
blocked.addSubnet("10.0.0.0", 8, "ipv4");
blocked.addSubnet("100.64.0.0", 10, "ipv4"); // CGNAT
blocked.addSubnet("127.0.0.0", 8, "ipv4");
blocked.addSubnet("169.254.0.0", 16, "ipv4"); // link-local, cloud metadata
blocked.addSubnet("172.16.0.0", 12, "ipv4");
blocked.addSubnet("192.0.0.0", 24, "ipv4");
blocked.addSubnet("192.0.2.0", 24, "ipv4");
blocked.addSubnet("192.168.0.0", 16, "ipv4");
blocked.addSubnet("198.18.0.0", 15, "ipv4");
blocked.addSubnet("198.51.100.0", 24, "ipv4");
blocked.addSubnet("203.0.113.0", 24, "ipv4");
blocked.addSubnet("224.0.0.0", 4, "ipv4"); // multicast
blocked.addSubnet("240.0.0.0", 4, "ipv4"); // reserved + broadcast
// IPv6
blocked.addAddress("::", "ipv6"); // unspecified
blocked.addAddress("::1", "ipv6");
blocked.addSubnet("64:ff9b::", 96, "ipv6"); // NAT64 can reach IPv4 internals
blocked.addSubnet("100::", 64, "ipv6");
blocked.addSubnet("2001:db8::", 32, "ipv6");
blocked.addSubnet("fc00::", 7, "ipv6"); // unique local
blocked.addSubnet("fe80::", 10, "ipv6"); // link-local
blocked.addSubnet("ff00::", 8, "ipv6"); // multicast

const PRIVATE_NAME = [/^localhost$/i, /\.localhost$/i, /\.local$/i, /\.internal$/i, /\.home\.arpa$/i];

/** Extracts the embedded IPv4 of an IPv4-mapped/compatible IPv6 address (::ffff:a.b.c.d or ::ffff:7f00:1). */
function embeddedIpv4(v6: string): string | null {
  const lower = v6.toLowerCase();
  const dotted = /^(?:0{0,4}:){0,5}(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower.replace(/^::/, "0:0:0:0:0:"));
  if (dotted) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return null;
}

export function isBlockedIp(ip: string): boolean {
  const address = ip.replace(/^\[|\]$/g, "").split("%")[0];
  const family = isIP(address);
  if (family === 4) return blocked.check(address, "ipv4");
  if (family === 6) {
    const mapped = embeddedIpv4(address);
    if (mapped && isIP(mapped) === 4) return blocked.check(mapped, "ipv4");
    return blocked.check(address, "ipv6");
  }
  return true; // not an IP at all: treat as blocked when asked
}

/** Normalizes a URL hostname: strips IPv6 brackets and trailing dots (`localhost.`). */
export function normalizeHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").replace(/\.+$/, "").toLowerCase();
}

export function isPrivateHostname(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (!host) return true;
  if (isIP(host)) return isBlockedIp(host);
  return PRIVATE_NAME.some((re) => re.test(host));
}

export function isBuiltInSinkPath(value: string): boolean {
  const match = /^\/api\/sink\/([a-z]+)$/.exec(value);
  return !!match && isSinkKind(match[1]);
}

export type UrlPolicy = { sandbox: boolean; allowPrivate: boolean };

/** Static validation used when a destination is saved. Returns an error message or null. */
export function validateDestinationUrl(raw: string, policy: UrlPolicy): string | null {
  const value = raw.trim();
  if (value.startsWith("/")) {
    return isBuiltInSinkPath(value) ? null : "Relative URLs must be a built-in sink: /api/sink/ok, fail, flaky, slow or reject";
  }
  if (policy.sandbox) {
    return "The public sandbox only delivers to the built-in sinks (/api/sink/ok, fail, flaky, slow, reject). Run it with a database to use external URLs.";
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Enter a full URL (https://…) or a built-in sink path (/api/sink/ok)";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "Only http and https URLs are supported";
  if (url.username || url.password) return "Credentials in the URL are not allowed; use a token in the receiver instead";
  if (!policy.allowPrivate && isPrivateHostname(url.hostname)) return "Private, loopback and reserved hosts are not allowed";
  return null;
}

export type LookupFn = (hostname: string) => Promise<string[]>;

export const dnsLookup: LookupFn = async (hostname) => {
  const { lookup } = await import("node:dns/promises");
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => r.address);
};

/**
 * Runtime check right before an attempt. `rawUrl` is the stored destination URL.
 * Returns null when the request may proceed, otherwise the reason and whether it is permanent
 * (policy violation) or transient (DNS failure, retried like a network error).
 * Note: fetch resolves the name again, so a DNS answer that changes between the two lookups
 * (rebinding with a very short TTL) is not fully covered; see README.
 */
export type OutboundBlock = { error: string; permanent: boolean };

export async function checkOutboundUrl(rawUrl: string, policy: UrlPolicy, lookup: LookupFn = dnsLookup): Promise<OutboundBlock | null> {
  const deny = (error: string): OutboundBlock => ({ error, permanent: true });
  if (rawUrl.startsWith("/")) return isBuiltInSinkPath(rawUrl) ? null : deny("blocked: unknown built-in sink");
  if (policy.sandbox) return deny("blocked: sandbox only delivers to built-in sinks");
  const staticError = validateDestinationUrl(rawUrl, policy);
  if (staticError) return deny(`blocked: ${staticError}`);
  if (policy.allowPrivate) return null;

  const host = normalizeHost(new URL(rawUrl).hostname);
  if (isIP(host)) return isBlockedIp(host) ? deny("blocked: private or reserved address") : null;
  let addresses: string[];
  try {
    addresses = await lookup(host);
  } catch (err) {
    return { error: `dns lookup failed: ${err instanceof Error ? err.message : String(err)}`, permanent: false };
  }
  if (addresses.length === 0) return { error: "dns lookup returned no addresses", permanent: false };
  const bad = addresses.find(isBlockedIp);
  return bad ? deny(`blocked: ${host} resolves to a private or reserved address (${bad})`) : null;
}
