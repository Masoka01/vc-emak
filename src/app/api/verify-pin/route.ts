import { NextRequest, NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;
// Keeps the Map from growing without bound on a long-running process.
const MAX_TRACKED_CLIENTS = 500;

type Bucket = { failures: number; firstAt: number };

// Rate limit state is in memory, which means it resets on serverless cold
// starts and is not shared across instances. This is a speed bump against casual
// PIN guessing, not real protection. A durable store (Redis/Upstash) is the
// upgrade if the PIN ever needs to be genuinely hard to brute-force.
const attempts = new Map<string, Bucket>();

/**
 * Trusts x-forwarded-for / x-real-ip. That is only accurate when the app sits
 * behind a proxy that sets them (Vercel, Firebase Hosting). If it is ever exposed
 * directly, the header is client-controlled and the rate limit is bypassable.
 */
function clientKey(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

function prune(now: number): void {
  if (attempts.size <= MAX_TRACKED_CLIENTS) return;

  attempts.forEach((bucket, key) => {
    if (now - bucket.firstAt > WINDOW_MS) attempts.delete(key);
  });

  if (attempts.size <= MAX_TRACKED_CLIENTS) return;

  // Still oversized after dropping expired buckets: evict oldest insertions.
  const overflow = attempts.size - MAX_TRACKED_CLIENTS;
  Array.from(attempts.keys())
    .slice(0, overflow)
    .forEach((key) => attempts.delete(key));
}

function retryAfterSeconds(bucket: Bucket, now: number): number {
  return Math.max(1, Math.ceil((bucket.firstAt + WINDOW_MS - now) / 1000));
}

/**
 * Constant-time comparison. Hashing both sides to a fixed 32-byte digest first
 * means timingSafeEqual never has to bail out on a length mismatch, so a wrong
 * length cannot be distinguished from a wrong value by timing.
 */
function safeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

export async function POST(req: NextRequest) {
  const now = Date.now();
  const key = clientKey(req);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_request", message: "Permintaan tidak valid." },
      { status: 400 }
    );
  }

  const raw = (body as { pin?: unknown } | null)?.pin;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return NextResponse.json(
      { error: "invalid_request", message: "Permintaan tidak valid." },
      { status: 400 }
    );
  }
  const pin = raw.trim();

  // Checked before anything else so a missing secret is reported as a server
  // setup problem, never as a wrong PIN.
  const adminPin = process.env.ADMIN_PIN;
  if (!adminPin) {
    return NextResponse.json(
      { error: "server_misconfigured", message: "Server belum dikonfigurasi." },
      { status: 500 }
    );
  }

  prune(now);

  const bucket = attempts.get(key);
  if (bucket && bucket.failures >= MAX_ATTEMPTS) {
    const retryAfter = retryAfterSeconds(bucket, now);
    return NextResponse.json(
      { error: "too_many_attempts", retryAfter, message: "Terlalu banyak percobaan." },
      { status: 429, headers: { "Retry-After": String(retryAfter) } }
    );
  }

  if (safeEqual(pin, adminPin.trim())) {
    attempts.delete(key);
    return NextResponse.json({ ok: true });
  }

  // Only failures count toward the limit.
  const next: Bucket =
    bucket && now - bucket.firstAt <= WINDOW_MS
      ? { failures: bucket.failures + 1, firstAt: bucket.firstAt }
      : { failures: 1, firstAt: now };
  attempts.set(key, next);

  return NextResponse.json(
    { error: "invalid_pin", message: "PIN salah." },
    { status: 401 }
  );
}

function methodNotAllowed() {
  return NextResponse.json(
    { error: "method_not_allowed", message: "Metode tidak diizinkan." },
    { status: 405, headers: { Allow: "POST" } }
  );
}

export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
