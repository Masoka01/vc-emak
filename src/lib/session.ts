import { createHmac, createHash, timingSafeEqual } from "node:crypto";

/**
 * Session tokens for the admin page.
 *
 * SERVER ONLY. This module reads SESSION_SECRET and ADMIN_PIN, neither of which
 * is available in the browser bundle, so it must never be imported from a client
 * component. Only the route handlers under src/app/api may import it.
 *
 * How it works:
 *   token = base64url(payload) + "." + base64url(HMAC-SHA256(payload, SESSION_SECRET))
 *
 * The payload carries a fingerprint of the PIN the token was issued against, not
 * the PIN itself. That gives us revocation for free: when ADMIN_PIN changes, the
 * stored fingerprint no longer matches and every previously issued token is
 * rejected, with no session table and no explicit logout-everywhere.
 *
 * The HMAC is what stops anyone from minting their own token, so this is safe to
 * hand out from a public endpoint. Remember-me tokens intentionally have no
 * expiry of their own; the PIN fingerprint is the invalidation mechanism.
 */

const VERSION = 1;

export const COOKIE_NAME = "vconnect_admin";

/**
 * Ten years. Combined with fingerprint-based revocation this is what makes
 * "remember me" mean "until the PIN changes" rather than "for N days".
 */
export const REMEMBER_MAX_AGE = 10 * 365 * 24 * 60 * 60;

function sign(payloadB64: string, secret: string): string {
  return createHmac("sha256", secret).update(payloadB64).digest("base64url");
}

/** Short, non-reversible marker for a PIN. Never log this alongside the PIN. */
export function pinFingerprint(pin: string): string {
  return createHash("sha256").update(pin).digest("hex").slice(0, 16);
}

/** Compares two strings without leaking their contents through timing. */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function createSessionToken(pin: string, secret: string): string {
  const payload = { v: VERSION, fp: pinFingerprint(pin), iat: Date.now() };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${payloadB64}.${sign(payloadB64, secret)}`;
}

export function verifySessionToken(
  token: string,
  secret: string,
  currentPin: string
): boolean {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return false;

  const payloadB64 = token.slice(0, dot);
  if (!safeEqual(sign(payloadB64, secret), token.slice(dot + 1))) return false;

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString()) as {
      v?: unknown;
      fp?: unknown;
    };
    if (payload.v !== VERSION) return false;
    return safeEqual(String(payload.fp ?? ""), pinFingerprint(currentPin));
  } catch {
    return false;
  }
}

/** Shape shared by the session endpoints, so the client has one contract. */
export function isSessionConfigured(): boolean {
  return Boolean(process.env.SESSION_SECRET && process.env.ADMIN_PIN);
}

export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  path: "/",
} as const;
