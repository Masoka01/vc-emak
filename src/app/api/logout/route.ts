import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { COOKIE_NAME, sessionCookieOptions } from "@/lib/session";

/** Clears the admin session cookie. The client forgets the token with it. */
export async function POST() {
  cookies().set(COOKIE_NAME, "", { ...sessionCookieOptions, maxAge: 0 });
  return NextResponse.json({ ok: true });
}
