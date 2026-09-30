import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  COOKIE_NAME,
  REMEMBER_MAX_AGE,
  createSessionToken,
  isSessionConfigured,
  sessionCookieOptions,
  verifySessionToken,
} from "@/lib/session";

/**
 * Reports whether the caller already holds a valid admin session, so the admin
 * page can skip the PIN screen on load.
 *
 * The token is validated here rather than trusted from the client. Note that the
 * browser cannot verify it itself: doing so would require shipping SESSION_SECRET
 * to the client.
 */
export async function GET() {
  if (!isSessionConfigured()) {
    return NextResponse.json(
      { error: "server_misconfigured", message: "Server belum dikonfigurasi." },
      { status: 500 }
    );
  }

  const token = cookies().get(COOKIE_NAME)?.value;
  if (!token) {
    return NextResponse.json({ error: "no_session" }, { status: 401 });
  }

  const valid = verifySessionToken(
    token,
    process.env.SESSION_SECRET as string,
    process.env.ADMIN_PIN as string
  );

  if (!valid) {
    // A stale cookie usually means the PIN changed. Clear it so the next load
    // starts clean instead of re-checking on every render.
    cookies().delete(COOKIE_NAME);
    return NextResponse.json({ error: "invalid_session" }, { status: 401 });
  }

  return NextResponse.json({ authenticated: true });
}
