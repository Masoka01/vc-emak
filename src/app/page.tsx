"use client";

import { useEffect, useCallback } from "react";
import { listenForCall, answerCall } from "@/lib/webrtc";
import { useVideoCall } from "@/hooks/useVideoCall";

export default function ReceiverPage() {
  const {
    pcRef,
    cleanupRef,
    callState,
    setCallState,
    localVideoRef,
    remoteVideoRef,
    getLocalStream,
    initPC,
    setRemoteStream,
    endCall,
    armed,
    arm,
    disarm,
    permission,
    micEnabled,
    setMicEnabled,
  } = useVideoCall();

  const handleAnswer = useCallback(async () => {
    setCallState("connecting");
    try {
      const pc = initPC();
      const localStream = await getLocalStream();
      localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
      const cleanup = await answerCall(pc, setRemoteStream);
      cleanupRef.current = cleanup;
    } catch (err) {
      console.error(err);
      setCallState("error");
    }
  }, [initPC, getLocalStream, setRemoteStream, setCallState, cleanupRef]);

  useEffect(() => {
    const unsub = listenForCall(() => {
      if ((callState === "idle" || callState === "ended") && armed) {
        handleAnswer();
      }
    });

    return () => unsub();
  }, [callState, armed, handleAnswer]);

  const isInCall = callState === "connecting" || callState === "connected";
  const isArmed = armed && permission === "granted";
  const isPermissionDenied = permission === "denied";

  // Logo SVG (padlock) — same mark as the admin login and the PWA icon
  const LockIcon = () => (
    <svg
      width="56"
      height="56"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden="true"
    >
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );

  // Small live preview for armed state
  const ArmedPreview = () => (
    <video
      ref={localVideoRef}
      autoPlay
      playsInline
      muted
      className="absolute -bottom-6 -right-6 h-20 w-20 aspect-square rounded-lg border-2 border-teal-bg/50 object-cover shadow-lg"
      aria-hidden="true"
    />
  );

  // In-call controls: mute toggle + hang up
  const InCallControls = () => (
    <div className="absolute inset-x-0 bottom-6 z-30 flex justify-center gap-4 px-4">
      <button
        onClick={() => setMicEnabled(!micEnabled)}
        aria-label={!micEnabled ? "Aktifkan mikrofon" : "Matikan mikrofon"}
        aria-pressed={!micEnabled}
        className="grid h-14 w-14 place-items-center rounded-full bg-surface-card/90 border border-line text-ink shadow-md transition-colors hover:border-brand hover:text-brand focus:outline-none focus:ring-2 focus:ring-brand"
      >
        {!micEnabled ? (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9a3 3 0 0 0-5.12-2.12" />
            <path d="M17 9v3a3 3 0 0 1-5.12 2.12" />
            <line x1="1" y1="1" x2="23" y2="23" />
          </svg>
        ) : (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M11 5L6 9H2v6h4l5 4V5z" />
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
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
  );

  return (
    <div className="relative h-dvh w-full overflow-hidden" style={{ background: "#000000" }}>
      {/* Video layer - always present, shown/hidden via opacity */}
      <video
        ref={remoteVideoRef}
        autoPlay
        playsInline
        className={`h-full w-full object-cover transition-opacity duration-300 ${
          isInCall ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
      />

      {/* Local PiP during call */}
      {isInCall && (
        <video
          ref={localVideoRef}
          autoPlay
          playsInline
          muted
          className="absolute bottom-5 right-5 aspect-[4/3] w-32 rounded-lg border-2 border-surface-card object-cover shadow-md transition-opacity duration-200 opacity-100"
        />
      )}

      {/* Idle / Armed / Permission Denied - centered logo */}
      {!isInCall && callState !== "error" && (
        <div className="absolute inset-0 flex items-center justify-center px-6 animate-fade-in">
          <div className="relative flex flex-col items-center gap-6 text-center">
            <button
              onClick={arm}
              aria-label={isArmed ? "Siap menerima panggilan" : isPermissionDenied ? "Izin ditolak. Ketuk untuk mencoba lagi" : "Aktifkan kamera dan mikrofon"}
              aria-pressed={isArmed}
              className="relative grid h-48 w-48 place-items-center rounded-full border-2 border-brand/50 text-brand transition-transform hover:scale-[1.02] active:scale-[0.98] focus:outline-none focus:ring-4 focus:ring-brand/50"
            >
              <LockIcon />
              {isArmed && <ArmedPreview />}
            </button>

            {isPermissionDenied && (
              <p className="max-w-xs text-sm text-ink-dim px-4">
                Kamera atau mikrofon ditolak. Izinkan akses di pengaturan browser lalu ketuk logo lagi.
              </p>
            )}

            {isArmed && !isPermissionDenied && (
              <p className="text-xs font-medium text-brand/80 tracking-wider uppercase">
                Siap menerima panggilan
              </p>
            )}
          </div>
        </div>
      )}

      {/* Connecting overlay */}
      {callState === "connecting" && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 bg-black/90">
          <div className="h-10 w-10 rounded-full border-2 border-teal-bg border-t-teal animate-spin" aria-hidden="true" />
          <p className="text-sm font-bold text-ink">Menyambungkan…</p>
        </div>
      )}

      {/* Error */}
      {callState === "error" && (
        <div className="absolute inset-0 flex items-center justify-center px-6">
          <p className="accent-bar-coral rounded-md bg-coral/12 px-4 py-3 text-sm font-medium text-coral-light text-center">
            Koneksi gagal. Refresh halaman.
          </p>
        </div>
      )}

      {/* In-call controls */}
      {isInCall && <InCallControls />}
    </div>
  );
}