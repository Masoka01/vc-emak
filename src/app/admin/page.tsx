"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { startCall } from "@/lib/webrtc";
import { useVideoCall } from "@/hooks/useVideoCall";
import { isFirebaseConfigured, missingFirebaseVars } from "@/lib/env";

type SessionStatus = "loading" | "authenticated" | "unauthenticated" | "misconfigured";

/**
 * Must match the length of ADMIN_PIN in .env.local. The input only accepts
 * digits, so the PIN has to be numeric — typing letters on a phone keypad is
 * miserable, and an 8-digit code is safe enough given the endpoint allows 5
 * failed attempts per 15 minutes.
 */
const PIN_LENGTH = 8;

type PinErrorCode =
  | "invalid_pin"
  | "too_many_attempts"
  | "server_misconfigured"
  | "network_error"
  | "invalid_request"
  | "";

interface PinError {
  code: PinErrorCode;
  message: string;
  retryAfter?: number;
}

const centeredPage = "flex min-h-dvh items-center justify-center bg-base px-4 py-6";
const card = "flex w-full max-w-sm flex-col items-center gap-5 rounded-2xl border border-line bg-surface p-8 shadow-lg animate-fade-in";
const spinner = "h-10 w-10 rounded-full border-2 border-line border-t-accent animate-spin";

export default function AdminPage() {
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>("loading");
  const [pin, setPin] = useState("");
  const [remember, setRemember] = useState(true);
  const [pinError, setPinError] = useState<PinError>({ code: "", message: "" });
  const [loading, setLoading] = useState(false);
  const [retryCountdown, setRetryCountdown] = useState(0);
  const [shake, setShake] = useState(false);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const shakeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Intervals and the shake timer must not outlive the component.
  useEffect(() => {
    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
      if (shakeTimeoutRef.current) clearTimeout(shakeTimeoutRef.current);
    };
  }, []);

  const {
    cleanupRef,
    callState,
    setCallState,
    localVideoRef,
    remoteVideoRef,
    getLocalStream,
    initPC,
    setRemoteStream,
    endCall,
  } = useVideoCall();

  // ── Session check on mount ──
  useEffect(() => {
    let mounted = true;

    const checkSession = async () => {
      try {
        const res = await fetch("/api/session", { credentials: "include" });
        if (!mounted) return;

        if (res.status === 200) {
          const data = await res.json();
          if (data.authenticated) {
            setSessionStatus("authenticated");
            return;
          }
        }
        if (res.status === 401) {
          setSessionStatus("unauthenticated");
          return;
        }
        if (res.status === 500) {
          setSessionStatus("misconfigured");
          return;
        }
        // Unexpected status
        setSessionStatus("unauthenticated");
      } catch {
        if (!mounted) return;
        // Network failure during session check — treat as unauthenticated
        // but we'll show a proper error if they try to submit
        setSessionStatus("unauthenticated");
      }
    };

    checkSession();

    return () => {
      mounted = false;
    };
  }, []);

  // ── Firebase config check ──
  const firebaseReady = isFirebaseConfigured();
  const missingVars = missingFirebaseVars();

  // ── Countdown for 429 ──
  useEffect(() => {
    if (retryCountdown > 0) {
      countdownRef.current = setInterval(() => {
        setRetryCountdown((prev) => {
          if (prev <= 1) {
            if (countdownRef.current) clearInterval(countdownRef.current);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    } else if (countdownRef.current) {
      clearInterval(countdownRef.current);
      countdownRef.current = null;
    }
    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, [retryCountdown]);

  // ── PIN verification ──
  const verifyPin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pin.trim()) return;

    setLoading(true);
    setPinError({ code: "", message: "" });

    try {
      const res = await fetch("/api/verify-pin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ pin, remember }),
      });

      const data = await res.json().catch(() => ({}));

      if (res.status === 200 && data.ok) {
        setSessionStatus("authenticated");
        setPin("");
        return;
      }

      const errorCode = data.error as PinErrorCode;
      const retryAfter = data.retryAfter as number | undefined;

      switch (errorCode) {
        case "invalid_pin":
          setPinError({
            code: "invalid_pin",
            message: "PIN salah. Coba lagi.",
          });
          // Finite shake, driven by state so it works with utility classes.
          setShake(true);
          if (shakeTimeoutRef.current) clearTimeout(shakeTimeoutRef.current);
          shakeTimeoutRef.current = setTimeout(() => setShake(false), 400);
          // Clear input and refocus
          setPin("");
          setTimeout(() => inputRef.current?.focus(), 50);
          break;
        case "too_many_attempts":
          setPinError({
            code: "too_many_attempts",
            message: "Terlalu banyak percobaan.",
            retryAfter,
          });
          if (retryAfter) setRetryCountdown(retryAfter);
          setPin("");
          break;
        case "server_misconfigured":
          setPinError({
            code: "server_misconfigured",
            message: "Server belum dikonfigurasi. Hubungi administrator.",
          });
          break;
        case "invalid_request":
          setPinError({
            code: "invalid_request",
            message: "Permintaan tidak valid.",
          });
          break;
        default:
          setPinError({
            code: "network_error",
            message: "Tidak dapat menghubungi server. Periksa koneksi.",
          });
      }
    } catch {
      setPinError({
        code: "network_error",
        message: "Tidak dapat menghubungi server. Periksa koneksi.",
      });
    } finally {
      setLoading(false);
    }
  };

  // ── Logout ──
  const handleLogout = async () => {
    try {
      await fetch("/api/logout", { method: "POST", credentials: "include" });
    } catch {
      // Ignore network errors on logout
    }
    setSessionStatus("unauthenticated");
    setPin("");
    setPinError({ code: "", message: "" });
  };

  // ── Start call ──
  const handleCall = useCallback(async () => {
    setCallState("connecting");
    try {
      const pc = initPC();
      const localStream = await getLocalStream();
      localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
      const cleanup = await startCall(pc, setRemoteStream);
      cleanupRef.current = cleanup;
    } catch (err) {
      console.error(err);
      setCallState("error");
    }
  }, [initPC, getLocalStream, setRemoteStream, setCallState, cleanupRef]);

  const isInCall = callState === "connecting" || callState === "connected";

  // ── Render states ──

  // Loading session check
  if (sessionStatus === "loading") {
    return (
      <div className={centeredPage}>
        <div className={card}>
          <div className={spinner} aria-hidden="true" />
          <p className="text-sm text-ink-muted">Memeriksa sesi…</p>
        </div>
      </div>
    );
  }

  // Firebase not configured
  if (!firebaseReady) {
    return (
      <div className={centeredPage}>
        <div className={`${card} items-stretch`}>
          <div className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-warning/15 text-warning">
            <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          </div>
          <h1 className="text-center text-xl font-semibold text-ink">Belum Dikonfigurasi</h1>
          <p className="text-center text-sm text-ink-dim">
            Variabel lingkungan Firebase berikut belum disetel:
          </p>
          <ul className="space-y-1.5">
            {missingVars.map((v) => (
              <li key={v} className="rounded-lg border border-warning/20 bg-warning/5 px-3 py-2 font-mono text-xs text-warning">
                {v}
              </li>
            ))}
          </ul>
          <p className="text-center text-xs leading-relaxed text-ink-muted">
            Tambahkan variabel tersebut ke{" "}
            <code className="rounded bg-surface-elevated px-1 py-0.5 font-mono text-ink-dim">.env.local</code>{" "}
            dan restart server.
          </p>
        </div>
      </div>
    );
  }

  // PIN screen
  if (sessionStatus === "unauthenticated") {
    const isThrottled = pinError.code === "too_many_attempts";
    const isServerError = pinError.code === "server_misconfigured" || pinError.code === "network_error";
    const errorTone =
      pinError.code === "invalid_pin"
        ? "bg-danger/15 text-danger"
        : isServerError || isThrottled
          ? "bg-warning/15 text-warning"
          : "bg-danger/15 text-danger";

    return (
      <div className={centeredPage}>
        <form onSubmit={verifyPin} noValidate className={card}>
          <div className="grid h-14 w-14 place-items-center rounded-2xl bg-accent/15 text-accent">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          </div>

          <div className="space-y-1 text-center">
            <h1 className="text-xl font-semibold text-ink">Admin</h1>
            <p className="text-sm text-ink-dim">Masukkan PIN untuk melanjutkan</p>
          </div>

          <div className="relative w-full">
            <input
              ref={inputRef}
              type="password"
              inputMode="numeric"
              placeholder="••••••••"
              value={pin}
              onChange={(e) => {
                // PENTING: jangan pasang maxLength di input ini.
                // maxLength memotong teks MENTAH sebelum filter di bawah jalan,
                // jadi paste "PIN: 56028717" (13 karakter) terpotong jadi
                // "PIN: 560" -> hanya "560" yang lolos. Clipboard yang punya
                // label, spasi, atau newline di depan akan selalu gagal.
                // Batas panjang sudah dijamin slice() di bawah, jadi
                // maxLength hanya menambah satu sumber bug.
                const digits = e.target.value.replace(/\D/g, "").slice(0, PIN_LENGTH);
                setPin(digits);
              }}
              autoComplete="off"
              required
              disabled={loading || isThrottled}
              aria-describedby={pinError.message ? "pin-error" : undefined}
              aria-invalid={pinError.code === "invalid_pin"}
              className={`w-full rounded-xl border bg-base py-3.5 pl-4 pr-14 text-center font-mono text-xl tracking-[0.4em] text-ink transition-colors placeholder:text-ink-muted/40 disabled:opacity-50 ${
                shake ? "animate-shake" : ""
              } ${pinError.code === "invalid_pin" ? "border-danger" : "border-line focus:border-accent"}`}
            />
            <span
              aria-hidden="true"
              className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-xs tabular-nums text-ink-muted"
            >
              {pin.length}/{PIN_LENGTH}
            </span>
          </div>

          {pinError.message && (
            <p id="pin-error" role="alert" aria-live="assertive" className={`w-full rounded-lg px-3 py-2 text-center text-sm ${errorTone}`}>
              {pinError.message}
              {isThrottled && pinError.retryAfter && (
                <span className="tabular-nums"> Coba lagi dalam {retryCountdown}s</span>
              )}
            </p>
          )}

          <label className="flex w-full cursor-pointer items-start gap-3 rounded-xl border border-line bg-base p-3 transition-colors hover:border-line-strong">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              disabled={loading}
              className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
            />
            <span className="space-y-0.5">
              <span className="block text-sm font-medium text-ink">Ingat saya</span>
              <span className="block text-xs leading-relaxed text-ink-muted">
                {remember
                  ? "Tetap masuk di perangkat ini sampai PIN diganti"
                  : "Sesi berakhir saat browser ditutup"}
              </span>
            </span>
          </label>

          <button
            type="submit"
            disabled={loading || !pin.trim() || isThrottled}
            aria-busy={loading}
            className="w-full rounded-xl bg-accent py-3 text-sm font-semibold text-white transition-colors hover:bg-accent/90"
          >
            {loading ? "Memeriksa…" : "Masuk"}
          </button>
        </form>
      </div>
    );
  }

  // ── Caller dashboard (authenticated) ──
  return (
    <div className="relative h-dvh w-full overflow-hidden bg-base text-ink">
      <video ref={remoteVideoRef} autoPlay playsInline className="h-full w-full object-cover" />
      <video
        ref={localVideoRef}
        autoPlay
        playsInline
        muted
        className={`absolute bottom-5 right-5 h-28 w-21 rounded-lg border border-line object-cover shadow-md transition-opacity duration-200 ${
          isInCall ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />

      <header className="absolute inset-x-0 top-0 z-20 flex items-center justify-between border-b border-line bg-base/80 px-4 py-3">
        <span className="rounded-full border border-line bg-surface px-3 py-1 text-xs uppercase tracking-widest text-ink-dim">
          Admin
        </span>
        <button
          onClick={handleLogout}
          aria-label="Keluar"
          title="Keluar"
          className="grid h-9 w-9 place-items-center rounded-lg border border-line text-ink-dim transition-colors hover:border-danger hover:text-danger"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
        </button>
      </header>

      {/* Idle / ready to call */}
      {!isInCall && callState !== "error" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-7 bg-base px-6 text-center animate-fade-in">
          <div className="relative grid h-24 w-24 place-items-center rounded-full bg-accent/15 text-accent">
            <div className="absolute inset-0 rounded-full border border-accent/20" />
            <svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
              <polygon points="23 7 16 12 23 17 23 7" />
              <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
            </svg>
          </div>

          <div className="space-y-2">
            <h2 className="text-2xl font-semibold text-ink">Siap Menelepon</h2>
            <p className="text-sm text-ink-dim">Tekan tombol di bawah untuk memulai panggilan video</p>
          </div>

          <button
            onClick={handleCall}
            className="rounded-xl bg-accent px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-accent/90"
          >
            Mulai Panggilan
          </button>
        </div>
      )}

      {/* Connecting */}
      {callState === "connecting" && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 bg-base/90 text-center">
          <div className={spinner} aria-hidden="true" />
          <div className="space-y-1">
            <p className="text-sm font-medium text-ink">Menghubungi receiver…</p>
            <p className="text-xs text-ink-muted">Menunggu receiver menjawab</p>
          </div>
        </div>
      )}

      {/* Error */}
      {callState === "error" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 bg-base px-6 text-center">
          <p className="text-sm text-danger">Koneksi gagal.</p>
          <button
            onClick={handleCall}
            className="rounded-xl bg-accent px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-accent/90"
          >
            Coba Lagi
          </button>
        </div>
      )}

      {/* Ended */}
      {callState === "ended" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 bg-base px-6 text-center">
          <p className="text-sm text-ink-dim">Panggilan selesai.</p>
          <button
            onClick={handleCall}
            className="rounded-xl bg-accent px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-accent/90"
          >
            Panggil Lagi
          </button>
        </div>
      )}

      {/* In-call controls */}
      {isInCall && (
        <div className="absolute inset-x-0 bottom-8 z-30 flex justify-center">
          <button
            onClick={endCall}
            aria-label="Akhiri panggilan"
            className="grid h-16 w-16 place-items-center rounded-full bg-danger text-white shadow-lg transition-colors hover:bg-danger/90"
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1L6.6 10.8z" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}
