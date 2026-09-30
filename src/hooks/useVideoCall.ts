"use client";
import { useRef, useState, useCallback } from "react";
import { createPeerConnection, hangUp } from "@/lib/webrtc";

export type CallState = "idle" | "connecting" | "connected" | "ended" | "error";

export function useVideoCall() {
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const [callState, setCallState] = useState<CallState>("idle");
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);

  const getLocalStream = useCallback(async (): Promise<MediaStream> => {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 1280, height: 720, facingMode: "user" },
      audio: true,
    });
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = stream;
    }
    return stream;
  }, []);

  const initPC = useCallback(() => {
    if (pcRef.current) pcRef.current.close();
    const pc = createPeerConnection();
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === "connected") setCallState("connected");
      if (state === "disconnected" || state === "failed" || state === "closed") {
        setCallState("ended");
      }
    };
    pcRef.current = pc;
    return pc;
  }, []);

  const setRemoteStream = useCallback((stream: MediaStream) => {
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = stream;
    }
  }, []);

  const endCall = useCallback(async () => {
    cleanupRef.current?.();
    await hangUp();
    pcRef.current?.close();
    pcRef.current = null;

    // Stop local tracks
    const localStream = localVideoRef.current?.srcObject as MediaStream | null;
    localStream?.getTracks().forEach((t) => t.stop());
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;

    setCallState("ended");
  }, []);

  return {
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
  };
}
