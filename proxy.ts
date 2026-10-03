import { NextResponse, type NextRequest } from "next/server";

/**
 * When RELAY_ADMIN_TOKEN is set, the dashboard (pages and the Server Actions they post to)
 * requires HTTP Basic auth with the token as password (any username). Without the token the
 * dashboard is open only in sandbox mode (the public demo); with DATABASE_URL set it answers 503.
 */
export function proxy(request: NextRequest) {
  const token = process.env.RELAY_ADMIN_TOKEN;
  if (!token) {
    // Open only in sandbox mode (no DATABASE_URL). With a real database and no token, fail closed.
    if (!process.env.DATABASE_URL) return NextResponse.next();
    return new NextResponse("RELAY_ADMIN_TOKEN is not configured. Set it to open the dashboard.", { status: 503 });
  }

  const header = request.headers.get("authorization") ?? "";
  if (header.startsWith("Basic ")) {
    try {
      const decoded = atob(header.slice(6));
      const password = decoded.slice(decoded.indexOf(":") + 1);
      if (timingSafeEqualString(password, token)) return NextResponse.next();
    } catch {
      // fall through to 401
    }
  }
  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "www-authenticate": 'Basic realm="webhook-relay", charset="UTF-8"' },
  });
}

function timingSafeEqualString(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export const config = {
  matcher: ["/dashboard", "/dashboard/:path*"],
};
