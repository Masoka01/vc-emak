"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { startCall } from "@/lib/webrtc";
import { useVideoCall } from "@/hooks/useVideoCall";
import { isFirebaseConfigured, missingFirebaseVars } from "@/lib/env";
import styles from "./admin.module.css";

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

export default function AdminPage() {
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>("loading");
  const [pin, setPin] = useState("");
  const [remember, setRemember] = useState(true);
  const [pinError, setPinError] = useState<PinError>({ code: "", message: "" });
  const [loading, setLoading] = useState(false);
  const [retryCountdown, setRetryCountdown] = useState(0);
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

      // Handle specific error codes
      const errorCode = data.error as PinErrorCode;
      const retryAfter = data.retryAfter as number | undefined;

      switch (errorCode) {
        case "invalid_pin":
          setPinError({
            code: "invalid_pin",
            message: "PIN salah. Coba lagi.",
          });
          // Shake animation trigger
          inputRef.current?.classList.add(styles.shake);
          if (shakeTimeoutRef.current) clearTimeout(shakeTimeoutRef.current);
          shakeTimeoutRef.current = setTimeout(
            () => inputRef.current?.classList.remove(styles.shake),
            400
          );
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
      <div className={styles.loadingRoot}>
        <div className={styles.loadingCard}>
          <div className={styles.spinner} aria-hidden="true" />
          <p className={styles.loadingText}>Memeriksa sesi…</p>
        </div>
      </div>
    );
  }

  // Firebase not configured
  if (!firebaseReady) {
    return (
      <div className={styles.configRoot}>
        <div className={styles.configCard}>
          <div className={styles.configIcon} aria-hidden="true">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          </div>
          <h1 className={styles.configTitle}>Belum Dikonfigurasi</h1>
          <p className={styles.configText}>
            Variabel lingkungan Firebase berikut belum disetel:
          </p>
          <ul className={styles.configList}>
            {missingVars.map((v) => (
              <li key={v} className={styles.configItem}>
                <code>{v}</code>
              </li>
            ))}
          </ul>
          <p className={styles.configHint}>
            Tambahkan variabel tersebut ke <code>.env.local</code> dan restart server.
          </p>
        </div>
      </div>
    );
  }

  // PIN screen
  if (sessionStatus === "unauthenticated") {
    const isThrottled = pinError.code === "too_many_attempts";
    const isServerError = pinError.code === "server_misconfigured" || pinError.code === "network_error";

    return (
      <div className={styles.pinRoot}>
        <form className={styles.pinCard} onSubmit={verifyPin} noValidate>
          <div className={styles.lockIcon} aria-hidden="true">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          </div>
          <h1 className={styles.pinTitle}>Admin</h1>
          <p className={styles.pinSub}>Masukkan PIN untuk melanjutkan</p>

          <div className={styles.inputWrapper}>
            <input
              ref={inputRef}
              className={styles.pinInput}
              type="password"
              inputMode="numeric"
              placeholder="••••••••"
              value={pin}
              onChange={(e) => {
                const digits = e.target.value.replace(/\D/g, "").slice(0, PIN_LENGTH);
                setPin(digits);
              }}
              autoComplete="off"
              maxLength={PIN_LENGTH}
              required
              disabled={loading || isThrottled}
              aria-describedby={pinError.message ? "pin-error" : undefined}
              aria-invalid={pinError.code === "invalid_pin"}
            />
            <span className={styles.pinLength} aria-hidden="true">
              {pin.length}/{PIN_LENGTH}
            </span>
          </div>

          {pinError.message && (
            <p
              id="pin-error"
              className={`${styles.pinError} ${pinError.code === "invalid_pin" ? styles.errorDanger : ""} ${isServerError ? styles.errorWarning : ""} ${isThrottled ? styles.errorWarning : ""}`}
              role="alert"
              aria-live="assertive"
            >
              {pinError.message}
              {isThrottled && pinError.retryAfter && (
                <span className={styles.countdown}>
                  {" "}
                  Coba lagi dalam {retryCountdown}s
                </span>
              )}
            </p>
          )}

          <label className={styles.rememberRow}>
            <input
              type="checkbox"
              className={styles.rememberCheckbox}
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              disabled={loading}
            />
            <span className={styles.rememberLabel}>Ingat saya</span>
            <span className={styles.rememberHint}>
              {remember
                ? "Tetap masuk di perangkat ini sampai PIN diganti"
                : "Sesi berakhir saat browser ditutup"}
            </span>
          </label>

          <button
            className={styles.pinBtn}
            type="submit"
            disabled={loading || !pin.trim() || isThrottled}
            aria-busy={loading}
          >
            {loading ? "Memeriksa…" : "Masuk"}
          </button>
        </form>
      </div>
    );
  }

  // ── Caller dashboard (authenticated) ──
  return (
    <div className={styles.root}>
      {/* Video layer */}
      <div className={styles.videos} data-active={isInCall}>
        <video ref={remoteVideoRef} className={styles.remote} autoPlay playsInline />
        <video ref={localVideoRef} className={styles.local} autoPlay playsInline muted />
      </div>

      {/* Header with logout */}
      <header className={styles.header}>
        <span className={styles.badge}>Admin</span>
        <button
          className={styles.logoutBtn}
          onClick={handleLogout}
          aria-label="Keluar"
          title="Keluar"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
        </button>
      </header>

      {/* Idle / ready to call */}
      {!isInCall && callState !== "error" && (
        <div className={styles.idle}>
          <div className={styles.callIcon} aria-hidden="true">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3">
              <polygon points="23 7 16 12 23 17 23 7" />
              <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
            </svg>
          </div>
          <h2 className={styles.readyText}>Siap Menelepon</h2>
          <p className={styles.readySub}>
            Tekan tombol di bawah untuk memulai panggilan video
          </p>
          <button className={styles.callBtn} onClick={handleCall}>
            Mulai Panggilan
          </button>
        </div>
      )}

      {/* Connecting */}
      {callState === "connecting" && (
        <div className={styles.overlay}>
          <div className={styles.spinner} aria-hidden="true" />
          <p>Menghubungi receiver…</p>
          <p className={styles.overlaySub}>Menunggu receiver menjawab</p>
        </div>
      )}

      {/* Error */}
      {callState === "error" && (
        <div className={styles.idle}>
          <p className={styles.errorText}>Koneksi gagal.</p>
          <button className={styles.callBtn} onClick={handleCall}>Coba Lagi</button>
        </div>
      )}

      {/* Ended */}
      {callState === "ended" && (
        <div className={styles.idle}>
          <p className={styles.endedText}>Panggilan selesai.</p>
          <button className={styles.callBtn} onClick={handleCall}>Panggil Lagi</button>
        </div>
      )}

      {/* In-call controls */}
      {isInCall && (
        <div className={styles.controls}>
          <button className={styles.hangup} onClick={endCall} aria-label="Akhiri panggilan">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
              <path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1L6.6 10.8z" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}