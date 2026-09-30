"use client";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { createPeerConnection, hangUp } from "@/lib/webrtc";
import { useWakeLock } from "./useWakeLock";

export type CallState = "idle" | "connecting" | "connected" | "ended" | "error";
export type PermissionState = "unknown" | "prompt" | "granted" | "denied";

export function useVideoCall() {
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const [callState, setCallState] = useState<CallState>("idle");
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);

  // The streams live in refs, not state, because they arrive from pc.ontrack —
  // a plain callback that can fire before the matching <video> element exists.
  // Storing them in state and assigning inline is what used to drop the remote
  // stream on the floor: ontrack fires exactly once, so a miss is permanent.
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  // pc.ontrack cannot re-render the tree, so bump a counter to let the attach
  // effect below run once the element is committed.
  const [attachTick, bumpAttach] = useReducer((n: number) => n + 1, 0);

  const [armed, setArmed] = useState(false);
  const [permission, setPermission] = useState<PermissionState>("unknown");
  // Mic state lives here, on the cached stream, rather than being derived from
  // whichever <video> element happens to hold the ref right now — that ref moves
  // between the armed preview and the in-call picture-in-picture.
  const [micEnabled, setMicEnabledState] = useState(true);
  const wakeLock = useWakeLock();

  const applyMicState = useCallback((enabled: boolean) => {
    localStreamRef.current?.getAudioTracks().forEach((t) => {
      t.enabled = enabled;
    });
  }, []);

  const setMicEnabled = useCallback(
    (enabled: boolean) => {
      applyMicState(enabled);
      setMicEnabledState(enabled);
    },
    [applyMicState]
  );

  useEffect(() => {
    let stale = false;

    const query = navigator.permissions as
      | { query?: (d: { name: string }) => Promise<PermissionStatus> }
      | undefined;

    if (!query?.query) {
      setPermission("unknown");
      return;
    }

    query
      .query({ name: "camera" })
      .then((status) => {
        if (stale) return;
        setPermission(status.state as PermissionState);
        status.onchange = () => {
          if (!stale) setPermission(status.state as PermissionState);
        };
      })
      .catch(() => {
        if (!stale) setPermission("unknown");
      });

    return () => {
      stale = true;
    };
  }, []);

  const getLocalStream = useCallback(async (): Promise<MediaStream> => {
    // Reuse the stream that arm() already opened. Calling getUserMedia again
    // would tear down and re-open the camera for no reason, and on some
    // devices that is slow enough to be noticed when a call comes in.
    if (localStreamRef.current) return localStreamRef.current;

    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 1280, height: 720, facingMode: "user" },
      audio: true,
    });
    localStreamRef.current = stream;
    // A fresh stream must honour the current mute choice, otherwise reopening
    // the mic after a hang-up would silently unmute.
    applyMicState(micEnabled);
    bumpAttach();
    return stream;
  }, [applyMicState, micEnabled]);

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
    remoteStreamRef.current = stream;
    bumpAttach();
  }, []);

  // Attach whatever we hold to whatever element is currently mounted. Depends on
  // callState because the elements are conditionally rendered around it.
  useEffect(() => {
    const local = localVideoRef.current;
    if (local && localStreamRef.current && local.srcObject !== localStreamRef.current) {
      local.srcObject = localStreamRef.current;
    }

    const remote = remoteVideoRef.current;
    if (remote && remoteStreamRef.current && remote.srcObject !== remoteStreamRef.current) {
      remote.srcObject = remoteStreamRef.current;
      // Two-way audio depends on this actually playing. The tap that armed the
      // receiver is the user gesture autoplay needs, so this normally resolves;
      // the catch keeps a blocked play from surfacing as an unhandled rejection.
      void remote.play().catch(() => {});
    }
  }, [attachTick, callState]);

  const clearMedia = useCallback(() => {
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    remoteStreamRef.current = null;
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    bumpAttach();
  }, []);

  const disarm = useCallback(() => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    pcRef.current?.close();
    pcRef.current = null;
    clearMedia();
    void wakeLock.release();
    setArmed(false);
    setCallState("idle");
  }, [clearMedia, wakeLock]);

  /**
   * One deliberate tap. Chrome's autoplay policy refuses to play remote audio
   * that was never unlocked by a user gesture, so without this the receiver can
   * send video but never hears the admin — which would make the "two-way" part
   * of the app silently one-way.
   */
  const arm = useCallback(async () => {
    if (armed) return;

    try {
      await getLocalStream();
      setPermission("granted");
      setArmed(true);
      void wakeLock.request();
    } catch {
      setPermission("denied");
      setArmed(false);
    }
  }, [armed, getLocalStream, wakeLock]);

  const endCall = useCallback(async () => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    await hangUp();
    pcRef.current?.close();
    pcRef.current = null;
    clearMedia();
    setCallState("ended");
    // Stay armed: the receiver is a phone left plugged in waiting for the next
    // call, so the camera, mic and wake lock are still wanted.
  }, [clearMedia]);

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
    armed,
    arm,
    disarm,
    permission,
    wakeLockActive: wakeLock.active,
    micEnabled,
    setMicEnabled,
  };
}
