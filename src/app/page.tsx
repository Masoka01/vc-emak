"use client";

import { useEffect, useCallback, useRef, useState } from "react";
import { listenForCall, answerCall } from "@/lib/webrtc";
import { useVideoCall } from "@/hooks/useVideoCall";

export default function ReceiverPage() {
  const {
    pcRef,
    cleanupRef,
    callState,
    setCallState,
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

  // Which call is on offer, and which one this receiver has already answered.
  // The room document fires many snapshots for a single call, so without these
  // two the receiver answers the same call repeatedly.
  const offeredCallIdRef = useRef<string | null>(null);
  const answeredCallIdRef = useRef<string | null>(null);

  const handleAnswer = useCallback(async (callId: string) => {
    // Claim the call before the first await. Two taps on the incoming screen
    // would otherwise both get past the guard below and answer the same call.
    answeredCallIdRef.current = callId;
    setCallState("connecting");
    // `step` is advanced before each await so the catch can name the failing
    // operation. Without it a NotFoundError from getUserMedia and an
    // InvalidStateError from setRemoteDescription on an already-closed pc were
    // indistinguishable in the console.
    let step = "initPeerConnection";
    try {
      const pc = initPC();
      step = "getLocalMedia";
      // Pass the facing explicitly rather than relying on the stream arm()
      // happened to open: the default is the front camera, so a cache miss
      // here would silently answer with the wrong one.
      const localStream = await getLocalStream({ facing: "environment" });
      step = "addTrack";
      localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
      step = "answerCall";
      // Release the previous call's Firestore listeners before replacing them.
      // Otherwise the room watcher and candidate listener from the last call
      // stay subscribed forever, still feeding ICE candidates into a
      // connection nobody owns any more.
      cleanupRef.current?.();
      // `disarm` returns the receiver to idle when the caller hangs up: it
      // closes this connection, stops the camera, and clears callState. Its
      // `setCallState("idle")` runs after the close, so it wins over the
      // "closed" that the close itself reports.
      const cleanup = await answerCall(pc, setRemoteStream, callId, disarm);
      cleanupRef.current = cleanup;
    } catch (err) {
      const name = err instanceof Error ? err.name : typeof err;
      const message = err instanceof Error ? err.message : String(err);

      // The call ended or was replaced while the receiver was answering. That
      // is a race, not a failure, and telling someone to refresh a page that is
      // working fine is the wrong response to it. Disarm releases the camera and
      // returns to idle; the receiver re-arms for the next call.
      if (
        message === "Panggilan sudah berakhir" ||
        message === "Panggilan sudah tidak aktif"
      ) {
        offeredCallIdRef.current = null;
        disarm();
        return;
      }

      console.error(`[receiver] gagal pada langkah: ${step}`, { step, name, message, err });
      setCallState("error");
    }
  }, [initPC, getLocalStream, setRemoteStream, setCallState, cleanupRef, disarm]);

  // An idle receiver cannot answer on its own, so an incoming call has to be
  // visible. Otherwise the caller waits on a connection the receiver is not
  // even looking at, with no way to tell the difference from a dead phone.
  const [incoming, setIncoming] = useState(false);
  const incomingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearIncoming = useCallback(() => {
    if (incomingTimerRef.current) {
      clearTimeout(incomingTimerRef.current);
      incomingTimerRef.current = null;
    }
    setIncoming(false);
  }, []);

  const acceptCall = useCallback(async () => {
    clearIncoming();
    // The prompt outlives the call it was raised for if the call is replaced in
    // the meantime, so re-read the id here rather than trusting the render.
    const callId = offeredCallIdRef.current;
    if (!callId) return;
    // Answering from idle means opening the camera first: there is no stream to
    // send until the receiver is armed.
    const ready = await arm({ facing: "environment" });
    if (ready) handleAnswer(callId);
  }, [arm, handleAnswer, clearIncoming]);

  useEffect(() => {
    const unsub = listenForCall((isIncoming, callId) => {
      // Cancel a pending auto-clear first: the room document fires several
      // snapshots while it still says "calling", and each of them must not
      // restart the countdown.
      if (incomingTimerRef.current) {
        clearTimeout(incomingTimerRef.current);
        incomingTimerRef.current = null;
      }

      if (!isIncoming || !callId) {
        setIncoming(false);
        offeredCallIdRef.current = null;
        return;
      }

      // Already answered this exact call. The room document still reports
      // "calling" for the whole window before our own answer lands, so without
      // this the receiver would answer the same call twice.
      if (answeredCallIdRef.current === callId) {
        setIncoming(false);
        offeredCallIdRef.current = null;
        return;
      }

      offeredCallIdRef.current = callId;

      // An armed receiver answers by itself, so prompting would only flash.
      if ((callState === "idle" || callState === "ended") && armed) {
        setIncoming(false);
        void handleAnswer(callId);
        return;
      }

      setIncoming(true);
      // Safety net: a caller who closes their tab without hanging up leaves the
      // room document saying "calling" forever, and the prompt would stick.
      incomingTimerRef.current = setTimeout(() => setIncoming(false), 30000);
    });

    return () => {
      unsub();
      if (incomingTimerRef.current) clearTimeout(incomingTimerRef.current);
    };
  }, [callState, armed, handleAnswer]);

  const isInCall = callState === "connecting" || callState === "connected";
  const isArmed = armed && permission === "granted";
  const isPermissionDenied = permission === "denied";

  // Logo SVG (padlock) — same mark as the admin login and the PWA icon
  const LockIcon = ({ className }: { className?: string }) => (
    <svg
      width="56"
      height="56"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden="true"
      className={className}
    >
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
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

      {/* No local PiP: the receiver's own camera is sent to the caller, so
          mirroring it back would only duplicate what the caller already has.
          The full-screen video above is the caller, which is the only thing
          worth the screen here. */}
      {/* Idle / Armed / Permission Denied - centered logo */}
      {!isInCall && !incoming && callState !== "error" && (
        <div className="absolute inset-0 flex items-center justify-center px-6 animate-fade-in">
          <div className="relative flex flex-col items-center gap-6 text-center">
            <button
              onClick={() => arm({ facing: "environment" })}
              aria-label={isArmed ? "Siap menerima panggilan" : isPermissionDenied ? "Izin ditolak. Ketuk untuk mencoba lagi" : "Aktifkan kamera dan mikrofon"}
              aria-pressed={isArmed}
              className="relative grid h-48 w-48 place-items-center rounded-full border-2 transition-transform hover:scale-[1.02] active:scale-[0.98] focus:outline-none focus:ring-4"
              style={{
                borderColor: isArmed ? "rgb(16 185 129)" : "rgba(16 185 129, 0.5)",
                color: isArmed ? "rgb(16 185 129)" : "rgba(16 185 129, 1)",
              }}
            >
              <LockIcon />
              {isArmed && (
                <span
                  className="absolute -top-1 -right-1 h-5 w-5 rounded-full bg-emerald-500 border-2 border-black"
                  aria-hidden="true"
                />
              )}
            </button>

            {isPermissionDenied && (
              <p className="max-w-xs text-sm text-ink-dim px-4">
                Kamera atau mikrofon ditolak. Izinkan akses di pengaturan browser lalu ketuk logo lagi.
              </p>
            )}
          </div>
        </div>
      )}

      {/* Incoming call while idle — distinct from "armed" (solid ring + green dot).
          Dashed ring = waiting passively. Pulsing solid ring + full-screen breath =
          "ringing right now". Whole screen is the tap target. */}
      {incoming && (
        <button
          onClick={() => void acceptCall()}
          aria-label="Panggilan masuk. Ketuk untuk menjawab"
          className="absolute inset-0 z-20 flex animate-fade-in flex-col items-center justify-center gap-6 px-6 text-center focus:outline-none focus-visible:ring-4 focus-visible:ring-brand/50"
        >
          {/* Full-screen subtle breath for urgency — respects reduced motion */}
          <div className="absolute inset-0 motion-safe:animate-pulse bg-brand/5" aria-hidden="true" />
          <div className="relative grid h-48 w-48 place-items-center">
            {/* Static dashed ring — always visible, distinct from armed's solid ring */}
            <span className="absolute inset-0 rounded-full border-2 border-dashed border-brand" aria-hidden="true" />
            {/* Pulsing solid ring — only when motion is allowed */}
            <span className="absolute inset-0 rounded-full border-2 border-brand/40 motion-safe:animate-pulse" aria-hidden="true" />
            {/* Lock icon stays steady */}
            <LockIcon className="relative text-brand" />
          </div>
          <span className="text-sm font-medium text-brand">Panggilan masuk</span>
          <span className="text-xs uppercase tracking-widest text-brand/70">
            Ketuk layar untuk menjawab
          </span>
        </button>
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