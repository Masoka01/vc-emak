"use client";

import { useEffect, useCallback, useState } from "react";
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
  } = useVideoCall();

  const [lastChecked, setLastChecked] = useState<Date>(new Date());

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
    // The timestamp is what communicates "still listening" now. The old design
    // used a forever-looping ripple to do that, which drained the battery of a
    // phone left plugged in waiting for a call.
    const interval = setInterval(() => {
      setLastChecked(new Date());
    }, 30000);

    const unsub = listenForCall(() => {
      if (callState === "idle" || callState === "ended") {
        handleAnswer();
      }
    });

    return () => {
      clearInterval(interval);
      unsub();
    };
  }, [callState, handleAnswer]);

  const isInCall = callState === "connecting" || callState === "connected";

  const formatTime = (date: Date) =>
    date.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });

  return (
    <div className="relative h-dvh w-full overflow-hidden bg-base text-ink">
      {/* Video layer */}
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

      {/* Idle screen */}
      {!isInCall && callState !== "error" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-7 bg-base px-6 text-center animate-fade-in">
          {/* Static marker. Intentionally not animated — see the note above. */}
          <div className="relative grid h-24 w-24 place-items-center rounded-full bg-accent/15 text-accent">
            <div className="absolute inset-0 rounded-full border border-accent/20" />
            <svg
              width="36"
              height="36"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <path d="M15.05 5A5 5 0 0 1 19 8.95M15.05 1A9 9 0 0 1 23 8.94m-1 7.98v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 9.4 19.79 19.79 0 0 1 1.61 4.7 2 2 0 0 1 3.6 2.5h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L7.91 10a16 16 0 0 0 6 6l.92-.92a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 21.5 18v.02z" />
            </svg>
          </div>

          <div className="space-y-2">
            <p className="text-lg font-medium text-ink">Menunggu panggilan masuk…</p>
            <p className="text-sm text-ink-muted">
              Terakhir diperiksa:{" "}
              <span className="tabular-nums">{formatTime(lastChecked)}</span>
            </p>
          </div>

          <span className="rounded-full border border-line bg-surface px-3 py-1 text-xs uppercase tracking-widest text-ink-dim">
            Receiver
          </span>
        </div>
      )}

      {/* Connecting overlay — the spinner is the one loop we keep, because it is
          only mounted for the ~2s the connection takes. */}
      {callState === "connecting" && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 bg-base/90">
          <div className="h-10 w-10 rounded-full border-2 border-line border-t-accent animate-spin" />
          <p className="text-sm text-ink-dim">Menyambungkan…</p>
        </div>
      )}

      {/* Error */}
      {callState === "error" && (
        <div className="absolute inset-0 flex items-center justify-center bg-base px-6">
          <p className="text-sm text-danger">Koneksi gagal. Refresh halaman.</p>
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
