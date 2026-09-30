"use client";
import { useEffect, useCallback } from "react";
import { listenForCall, answerCall } from "@/lib/webrtc";
import { useVideoCall } from "@/hooks/useVideoCall";
import styles from "./receiver.module.css";

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
    // Dengarkan panggilan masuk dari Firestore
    const unsub = listenForCall(() => {
      if (callState === "idle" || callState === "ended") {
        handleAnswer();
      }
    });
    return () => unsub();
  }, [callState, handleAnswer]);

  const isInCall = callState === "connecting" || callState === "connected";

  return (
    <div className={styles.root}>
      {/* Video layer */}
      <div className={styles.videos} data-active={isInCall}>
        {/* Remote (caller) — full screen */}
        <video
          ref={remoteVideoRef}
          className={styles.remote}
          autoPlay
          playsInline
        />
        {/* Local (receiver) — PiP */}
        <video
          ref={localVideoRef}
          className={styles.local}
          autoPlay
          playsInline
          muted
        />
      </div>

      {/* Idle screen */}
      {!isInCall && callState !== "error" && (
        <div className={styles.idle}>
          <div className={styles.pulse}>
            <div className={styles.ring} />
            <div className={styles.ring} />
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M15.05 5A5 5 0 0 1 19 8.95M15.05 1A9 9 0 0 1 23 8.94m-1 7.98v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 9.4 19.79 19.79 0 0 1 1.61 4.7 2 2 0 0 1 3.6 2.5h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L7.91 10a16 16 0 0 0 6 6l.92-.92a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 21.5 18v.02z"/>
            </svg>
          </div>
          <p className={styles.waitText}>Menunggu panggilan masuk…</p>
          <span className={styles.badge}>Receiver</span>
        </div>
      )}

      {/* Connecting overlay */}
      {callState === "connecting" && (
        <div className={styles.overlay}>
          <div className={styles.spinner} />
          <p>Menyambungkan…</p>
        </div>
      )}

      {/* Error */}
      {callState === "error" && (
        <div className={styles.idle}>
          <p className={styles.errorText}>Koneksi gagal. Refresh halaman.</p>
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
