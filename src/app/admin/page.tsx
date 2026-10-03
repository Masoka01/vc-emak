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

const page = "flex min-h-dvh items-center justify-center bg-surface-base px-4 py-8";
const card =
  "flex w-full max-w-md flex-col gap-6 rounded-xl border border-line bg-surface-card p-8 shadow-card animate-fade-in";
const spinner =
  "h-10 w-10 rounded-full border-2 border-teal-bg border-t-teal animate-spin";

/** Gold is a light fill, so its label must be dark ink — white on #FFD23F is ~1.6:1. */
const cta =
  "rounded-full bg-accent-gold px-6 py-3.5 text-base font-extrabold tracking-wide text-on-gold shadow-accent-glow transition-transform hover:bg-accent-gold-light";

export default function AdminPage() {
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>("loading");
  const [pin, setPin] = useState("");
  const [remember, setRemember] = useState(true);
  const [pinError, setPinError] = useState<PinError>({ code: "", message: "" });
  const [loading, setLoading] = useState(false);
  const [retryCountdown, setRetryCountdown] = useState(0);
  const [shake, setShake] = useState(false);
  const [showPin, setShowPin] = useState(false);
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
    micEnabled,
    setMicEnabled,
    videoEnabled,
    setVideoEnabled,
    cameraAvailable,
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

  // Grab the field as soon as the PIN screen appears — this is the single
  // biggest "susah ngetik" complaint: having to click the box first.
  useEffect(() => {
    if (sessionStatus === "unauthenticated") inputRef.current?.focus();
  }, [sessionStatus]);

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
    setShowPin(false);
  };

  // ── Start call ──
  const handleCall = useCallback(async () => {
    // If both camera and mic are off, there's nothing to send — don't call
    // getUserMedia with neither device. The admin must enable at least one.
    if (!videoEnabled && !micEnabled) return;

    setCallState("connecting");
    // `step` is advanced before each await so the catch block can name the
    // operation that actually threw. All four steps run inside one try/catch,
    // so a bare `console.error(err)` produced an undiagnosable report: a
    // NotFoundError from getUserMedia and a permission-denied from Firestore
    // looked identical from the console.
    let step = "initPeerConnection";
    try {
      const pc = initPC();
      step = "getLocalMedia";
      const localStream = await getLocalStream({
        video: videoEnabled,
        audio: micEnabled,
        facing: "user",
      });
      step = "addTrack";
      localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
      step = "startCall";
      const cleanup = await startCall(pc, setRemoteStream);
      cleanupRef.current = cleanup;
    } catch (err) {
      const name = err instanceof Error ? err.name : typeof err;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[admin] gagal pada langkah: ${step}`, { step, name, message, err });
      setCallState("error");
    }
  }, [initPC, getLocalStream, setRemoteStream, setCallState, cleanupRef, videoEnabled, micEnabled]);

  const isInCall = callState === "connecting" || callState === "connected";

  // ── Render states ──

  // Loading session check
  if (sessionStatus === "loading") {
    return (
      <div className={page}>
        <div className={card}>
          <div className={spinner} aria-hidden="true" />
          <p className="text-sm text-ink-dim">Memeriksa sesi…</p>
        </div>
      </div>
    );
  }

  // Firebase not configured
  if (!firebaseReady) {
    return (
      <div className={page}>
        <div className={`${card} items-stretch`}>
          <div className="mx-auto grid h-16 w-16 place-items-center rounded-lg bg-coral/15 text-coral-dark shadow-coral-glow">
            <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          </div>
          <h1 className="text-center text-2xl font-extrabold tracking-tight text-brand">
            Belum Dikonfigurasi
          </h1>
          <p className="text-center text-sm text-ink-dim">
            Variabel lingkungan Firebase berikut belum disetel:
          </p>
          <ul className="space-y-2">
            {missingVars.map((v) => (
              <li
                key={v}
                className="accent-bar-coral rounded-md bg-coral/10 px-3 py-2 font-mono text-sm text-coral-light"
              >
                {v}
              </li>
            ))}
          </ul>
          <p className="text-center text-xs leading-relaxed text-ink-muted">
            Tambahkan variabel tersebut ke{" "}
            <code className="rounded-sm bg-teal-bg px-1 py-0.5 font-mono text-teal-dark">
              .env.local
            </code>{" "}
            dan restart server.
          </p>
        </div>
      </div>
    );
  }

  // PIN screen
  if (sessionStatus === "unauthenticated") {
    const isThrottled = pinError.code === "too_many_attempts";
    const isServerError =
      pinError.code === "server_misconfigured" ||
      pinError.code === "network_error";
    const errorTone =
      pinError.code === "invalid_pin"
        ? "bg-coral/12 text-coral-light"
        : isServerError || isThrottled
          ? "bg-accent-gold/15 text-accent-gold-light"
          : "bg-coral/12 text-coral-light";

    const buildId = process.env.NEXT_PUBLIC_BUILD_ID;

    return (
      <div className={page}>
        <form onSubmit={verifyPin} noValidate className={card}>
          <div className="flex flex-col items-center gap-4 text-center">
            <div className="grid h-16 w-16 place-items-center rounded-lg bg-teal-bg text-teal-dark shadow-teal-glow">
              <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            </div>
            <div className="space-y-2">
              <h1 className="text-3xl font-extrabold tracking-tight text-brand">
                VConnect
              </h1>
              <p className="text-sm text-ink-dim">
                Masukkan PIN {PIN_LENGTH} digit untuk melanjutkan
              </p>
            </div>
          </div>

          <div className="divider-dashed" />

          <div className="space-y-2">
            <div className="flex items-baseline justify-between">
              <label
                htmlFor="pin"
                className="text-xs font-bold uppercase tracking-widest text-ink-dim"
              >
                PIN
              </label>
              <span
                aria-hidden="true"
                className="font-mono text-xs tabular-nums text-ink-muted"
              >
                {pin.length}/{PIN_LENGTH}
              </span>
            </div>

            <div className="relative">
              <input
                id="pin"
                ref={inputRef}
                type={showPin ? "text" : "password"}
                inputMode="numeric"
                autoComplete="off"
                placeholder="••••••••"
                value={pin}
                onChange={(e) => {
                  // PENTING: jangan pasang maxLength di input ini.
                  // maxLength memotong teks MENTAH sebelum filter di bawah jalan,
                  // jadi paste "PIN: 56028717" (13 karakter) terpotong jadi
                  // "PIN: 560" -> hanya "560" yang lolos.
                  const digits = e.target.value.replace(/\D/g, "").slice(0, PIN_LENGTH);
                  setPin(digits);
                }}
                onPaste={(e) => {
                  // Jalur terpisah dari onChange. Read the clipboard ourselves and
                  // own the whole value, so nothing about the browser's default
                  // paste handling can truncate it.
                  e.preventDefault();
                  const text = e.clipboardData.getData("text");
                  setPin(text.replace(/\D/g, "").slice(0, PIN_LENGTH));
                  setPinError({ code: "", message: "" });
                }}
                required
                disabled={loading || isThrottled}
                aria-describedby={pinError.message ? "pin-error" : undefined}
                aria-invalid={pinError.code === "invalid_pin"}
                className={`w-full rounded-md border-2 border-line bg-surface-input py-4 pl-16 pr-16 text-center font-mono text-2xl font-semibold tracking-[0.35em] text-ink transition-colors [text-indent:0.35em] placeholder:text-ink-muted/40 disabled:opacity-50 ${
                  shake ? "animate-shake" : ""
                } ${
                  pinError.code === "invalid_pin"
                    ? "border-coral"
                    : "focus:border-brand focus:shadow-teal-glow"
                }`}
              />

              {/* Symmetric pl/pr keeps the digits optically centred while the
                  button lives inside the padding instead of on top of it. */}
              <button
                type="button"
                onClick={() => setShowPin((v) => !v)}
                aria-label={showPin ? "Sembunyikan PIN" : "Tampilkan PIN"}
                aria-pressed={showPin}
                className="absolute right-2 top-1/2 grid h-12 w-12 -translate-y-1/2 place-items-center rounded-full text-ink-dim transition-colors hover:bg-teal-bg hover:text-teal-dark"
              >
                {showPin ? (
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                    <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
                    <line x1="1" y1="1" x2="23" y2="23" />
                  </svg>
                ) : (
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                )}
              </button>
            </div>
          </div>

          {pinError.message && (
            <p
              id="pin-error"
              role="alert"
              aria-live="assertive"
              className={`accent-bar-coral rounded-md px-4 py-3 text-sm font-medium ${errorTone}`}
            >
              {pinError.message}
              {isThrottled && pinError.retryAfter && (
                <span className="tabular-nums">
                  {" "}
                  Coba lagi dalam {retryCountdown}s
                </span>
              )}
            </p>
          )}

          <label className="flex w-full cursor-pointer items-start gap-3 rounded-md border-2 border-line bg-surface-input p-4 transition-colors hover:border-brand">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              disabled={loading}
              className="mt-1 h-5 w-5 shrink-0 accent-teal-light"
            />
            <span className="space-y-1">
              <span className="block text-sm font-bold text-ink">Ingat saya</span>
              <span className="block text-xs leading-relaxed text-ink-dim">
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
            className={`${cta} w-full disabled:hover:bg-accent-gold`}
          >
            {loading ? "Memeriksa…" : "Masuk"}
          </button>

          {buildId ? (
            <p className="text-center font-mono text-xs text-ink-muted">
              Build {buildId}
            </p>
          ) : null}
        </form>
      </div>
    );
  }

  // ── Caller dashboard (authenticated) ──
  return (
    <div className="relative h-dvh w-full overflow-hidden bg-surface-base text-ink">
      <video ref={remoteVideoRef} autoPlay playsInline className="h-full w-full object-cover" />
      {/* Local PiP during call — hidden when camera is unavailable or toggled off */}
      {isInCall && videoEnabled && cameraAvailable && (
        <video
          ref={localVideoRef}
          autoPlay
          playsInline
          muted
          className="absolute bottom-5 right-5 aspect-[4/3] w-32 rounded-lg border-2 border-surface-card object-cover shadow-md transition-opacity duration-200 opacity-100"
        />
      )}

      <header className="absolute inset-x-0 top-0 z-20 flex items-center justify-between px-4 py-3">
        <span className="rounded-full border border-line bg-surface-card/90 px-4 py-1.5 text-xs font-bold uppercase tracking-widest text-brand shadow-sm">
          Admin
        </span>
        <button
          onClick={handleLogout}
          aria-label="Keluar"
          title="Keluar"
          className="grid h-12 w-12 place-items-center rounded-full border border-line bg-surface-card/90 text-ink-dim shadow-sm transition-colors hover:border-coral hover:text-coral-light"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
        </button>
      </header>

      {/* Idle / ready to call — deliberately static: no pulse, no spin,
          nothing infinite. A spinner only ever mounts in the connecting branch. */}
      {!isInCall && callState !== "error" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-8 bg-surface-base px-6 text-center animate-fade-in">
          <div className="grid h-24 w-24 place-items-center rounded-full bg-teal-bg text-teal-dark shadow-teal-glow">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
              <polygon points="23 7 16 12 23 17 23 7" />
              <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
            </svg>
          </div>

          <div className="space-y-2">
            <h2 className="text-3xl font-extrabold tracking-tight text-brand">
              Siap Menelepon
            </h2>
            <p className="text-sm text-ink-dim">
              Tekan tombol di bawah untuk memulai panggilan video
            </p>
          </div>

          {/* Pre-call device toggles — default ON so the admin can opt out */}
          <div className="flex items-center justify-center gap-4">
            <button
              onClick={() => setVideoEnabled(!videoEnabled)}
              disabled={!cameraAvailable}
              aria-label={videoEnabled ? "Matikan kamera" : "Aktifkan kamera"}
              aria-pressed={videoEnabled}
              className={`grid h-14 w-14 place-items-center rounded-full border-2 transition-colors focus:outline-none focus:ring-2 focus:ring-brand ${
                cameraAvailable
                  ? videoEnabled
                    ? "bg-surface-card border-teal-bg text-teal-bg hover:bg-teal-bg/10"
                    : "bg-surface-card border-line text-ink-dim hover:border-brand hover:text-brand"
                    : "bg-surface-card/50 border-line/50 text-ink-muted cursor-not-allowed"
              }`}
            >
              {videoEnabled ? (
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                  <circle cx="12" cy="13" r="4" />
                </svg>
              ) : (
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                  <line x1="1" y1="1" x2="23" y2="23" />
                </svg>
              )}
            </button>

            <button
              onClick={() => setMicEnabled(!micEnabled)}
              aria-label={micEnabled ? "Matikan mikrofon" : "Aktifkan mikrofon"}
              aria-pressed={micEnabled}
              className={`grid h-14 w-14 place-items-center rounded-full border-2 transition-colors focus:outline-none focus:ring-2 focus:ring-brand ${
                micEnabled
                  ? "bg-surface-card border-teal-bg text-teal-bg hover:bg-teal-bg/10"
                  : "bg-surface-card border-line text-ink-dim hover:border-brand hover:text-brand"
              }`}
            >
              {micEnabled ? (
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                  <line x1="12" y1="19" x2="12" y2="22" />
                </svg>
              ) : (
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                  <line x1="1" y1="1" x2="23" y2="23" />
                  <line x1="12" y1="19" x2="12" y2="22" />
                </svg>
              )}
            </button>
          </div>

          {!cameraAvailable && (
            <p className="text-xs text-ink-muted">
              Kamera tidak tersedia — panggilan akan berjalan dengan mikrofon saja.
            </p>
          )}

          <button onClick={handleCall} className={cta}>
            Mulai Panggilan
          </button>
        </div>
      )}

      {/* Connecting */}
      {callState === "connecting" && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 bg-surface-base/90 text-center">
          <div className={spinner} aria-hidden="true" />
          <div className="space-y-1">
            <p className="text-sm font-bold text-ink">Menghubungi receiver…</p>
            <p className="text-xs text-ink-muted">Menunggu receiver menjawab</p>
          </div>
        </div>
      )}

      {/* Error */}
      {callState === "error" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 bg-surface-base px-6 text-center">
          <p className="accent-bar-coral rounded-md bg-coral/12 px-4 py-3 text-sm font-medium text-coral-light">
            Koneksi gagal.
          </p>
          <button onClick={handleCall} className={cta}>
            Coba Lagi
          </button>
        </div>
      )}

      {/* Ended */}
      {callState === "ended" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 bg-surface-base px-6 text-center">
          <p className="text-sm text-ink-dim">Panggilan selesai.</p>
          <button onClick={handleCall} className={cta}>
            Panggil Lagi
          </button>
        </div>
      )}

      {/* In-call controls — camera toggle, mic toggle, hangup */}
      {isInCall && (
        <div className="absolute inset-x-0 bottom-8 z-30 flex justify-center gap-4 px-4">
          <button
            onClick={() => setVideoEnabled(!videoEnabled)}
            disabled={!cameraAvailable}
            aria-label={videoEnabled ? "Matikan kamera" : "Aktifkan kamera"}
            aria-pressed={videoEnabled}
            className={`grid h-14 w-14 place-items-center rounded-full border-2 transition-colors focus:outline-none focus:ring-2 focus:ring-brand ${
              cameraAvailable
                ? videoEnabled
                  ? "bg-surface-card/90 border-teal-bg text-teal-bg hover:bg-teal-bg/10"
                  : "bg-surface-card/90 border-line text-ink-dim hover:border-brand hover:text-brand"
                  : "bg-surface-card/50 border-line/50 text-ink-muted cursor-not-allowed"
            }`}
          >
            {videoEnabled ? (
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                <circle cx="12" cy="13" r="4" />
              </svg>
            ) : (
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                <line x1="1" y1="1" x2="23" y2="23" />
              </svg>
            )}
          </button>

          <button
            onClick={() => setMicEnabled(!micEnabled)}
            aria-label={micEnabled ? "Matikan mikrofon" : "Aktifkan mikrofon"}
            aria-pressed={micEnabled}
            className={`grid h-14 w-14 place-items-center rounded-full border-2 transition-colors focus:outline-none focus:ring-2 focus:ring-brand ${
              micEnabled
                ? "bg-surface-card/90 border-teal-bg text-teal-bg hover:bg-teal-bg/10"
                : "bg-surface-card/90 border-line text-ink-dim hover:border-brand hover:text-brand"
            }`}
          >
            {micEnabled ? (
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="12" y1="19" x2="12" y2="22" />
              </svg>
            ) : (
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="1" y1="1" x2="23" y2="23" />
                <line x1="12" y1="19" x2="12" y2="22" />
              </svg>
            )}
          </button>

          <button
            onClick={endCall}
            aria-label="Akhiri panggilan"
            className="grid h-14 w-14 place-items-center rounded-full bg-coral text-on-coral shadow-coral-glow transition-transform hover:bg-coral-dark focus:outline-none focus:ring-2 focus:ring-coral"
          >
            <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1L6.6 10.8z" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}
