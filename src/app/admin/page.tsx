"use client";
import { useState, useCallback } from "react";
import { startCall } from "@/lib/webrtc";
import { useVideoCall } from "@/hooks/useVideoCall";
import styles from "./admin.module.css";

export default function AdminPage() {
  const [pin, setPin] = useState("");
  const [authed, setAuthed] = useState(false);
  const [pinError, setPinError] = useState("");
  const [loading, setLoading] = useState(false);

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

  // ── PIN verification ──
  const verifyPin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setPinError("");
    try {
      const res = await fetch("/api/verify-pin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      if (res.ok) {
        setAuthed(true);
      } else {
        setPinError("PIN salah. Coba lagi.");
      }
    } catch {
      setPinError("Terjadi kesalahan. Coba lagi.");
    } finally {
      setLoading(false);
    }
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

  // ── PIN screen ──
  if (!authed) {
    return (
      <div className={styles.pinRoot}>
        <form className={styles.pinCard} onSubmit={verifyPin}>
          <div className={styles.lockIcon}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
              <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
            </svg>
          </div>
          <h1 className={styles.pinTitle}>Admin</h1>
          <p className={styles.pinSub}>Masukkan PIN untuk melanjutkan</p>

          <input
            className={styles.pinInput}
            type="password"
            placeholder="••••••"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            autoComplete="current-password"
            required
          />
          {pinError && <p className={styles.pinError}>{pinError}</p>}

          <button className={styles.pinBtn} type="submit" disabled={loading || !pin}>
            {loading ? "Memeriksa…" : "Masuk"}
          </button>
        </form>
      </div>
    );
  }

  // ── Caller dashboard ──
  return (
    <div className={styles.root}>
      {/* Video layer */}
      <div className={styles.videos} data-active={isInCall}>
        <video ref={remoteVideoRef} className={styles.remote} autoPlay playsInline />
        <video ref={localVideoRef} className={styles.local} autoPlay playsInline muted />
      </div>

      {/* Idle / ready to call */}
      {!isInCall && callState !== "error" && (
        <div className={styles.idle}>
          <div className={styles.callIcon}>
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3">
              <polygon points="23 7 16 12 23 17 23 7"/>
              <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
            </svg>
          </div>
          <h2 className={styles.readyText}>Siap Menelepon</h2>
          <p className={styles.readySub}>
            Tekan tombol di bawah untuk memulai panggilan video
          </p>
          <button className={styles.callBtn} onClick={handleCall}>
            Mulai Panggilan
          </button>
          <span className={styles.badge}>Admin</span>
        </div>
      )}

      {/* Connecting */}
      {callState === "connecting" && (
        <div className={styles.overlay}>
          <div className={styles.spinner} />
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
              <path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1L6.6 10.8z"/>
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}
