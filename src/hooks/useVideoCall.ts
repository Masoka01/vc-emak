"use client";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { createPeerConnection, hangUp } from "@/lib/webrtc";
import { useWakeLock } from "./useWakeLock";

export type CallState = "idle" | "connecting" | "connected" | "ended" | "error";
export type PermissionState = "unknown" | "prompt" | "granted" | "denied";
export type CameraFacing = "user" | "environment";

export type GetLocalStreamOptions = {
  /** Request a camera track. Default true. */
  video?: boolean;
  /** Request a microphone track. Default true. */
  audio?: boolean;
  /** Which camera to prefer. Default "user" (PC webcam / selfie camera). */
  facing?: CameraFacing;
};

/**
 * getUserMedia rejects the whole request when any requested device class is
 * missing, so a caller on a PC with no webcam used to fail the entire call with
 * NotFoundError. These are the failure names that mean "this device class does
 * not exist here", which is a normal condition worth degrading out of rather
 * than an error worth surfacing.
 */
const DEVICE_MISSING = ["NotFoundError", "OverconstrainedError", "NotReadableError"] as const;

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
  // A PC without a webcam is a normal setup, not an error, so the caller can
  // place a call with the camera off instead of being blocked by it.
  const [cameraAvailable, setCameraAvailable] = useState(true);
  const [videoEnabled, setVideoEnabledState] = useState(true);
  const wakeLock = useWakeLock();

  const setVideoEnabled = useCallback((enabled: boolean) => {
    if (enabled && !localStreamRef.current?.getVideoTracks().length) {
      // Acquiring a camera mid-call needs renegotiation, which this hook does
      // not do. Refuse rather than report a lie to the UI.
      console.warn("[useVideoCall] tidak ada track kamera untuk diaktifkan");
      return;
    }
    localStreamRef.current?.getVideoTracks().forEach((t) => {
      t.enabled = enabled;
    });
    setVideoEnabledState(enabled);
  }, []);

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
        // "prompt" and "denied" both mean the OS has not granted us a camera
        // *yet*. arm() is the authority on whether the camera actually opened,
        // so reporting anything else here would contradict it — a machine with
        // no webcam at all reports "denied", which is not a rejection the user
        // can act on. Only a granted state is worth surfacing from here.
        if (status.state === "granted") setPermission("granted");
        else setPermission("unknown");
        status.onchange = () => {
          if (stale) return;
          if (status.state === "granted") setPermission("granted");
          else setPermission("unknown");
        };
      })
      .catch(() => {
        if (!stale) setPermission("unknown");
      });

    return () => {
      stale = true;
    };
  }, []);

  // Probe for a camera up front. Without this, `cameraAvailable` could only be
  // learned by actually attempting getUserMedia — which meant the caller had no
  // way to know before dialling that this machine has no webcam, and the
  // control that reports it was unreachable at exactly that moment.
  useEffect(() => {
    let stale = false;
    const md = navigator.mediaDevices as MediaDevices | undefined;
    if (!md?.enumerateDevices) return;

    md.enumerateDevices()
      .then((devices) => {
        if (stale) return;
        if (!devices.some((d) => d.kind === "videoinput")) {
          setCameraAvailable(false);
          setVideoEnabledState(false);
        }
      })
      .catch(() => {
        // Device enumeration can be refused; absence of knowledge is not proof
        // of absence, so leave the optimistic default in place.
      });

    return () => {
      stale = true;
    };
  }, []);

  const getLocalStream = useCallback(
    async (opts: GetLocalStreamOptions = {}): Promise<MediaStream> => {
      const { video = true, audio = true, facing = "user" } = opts;

      // Reuse the stream that arm() already opened. Calling getUserMedia again
      // would tear down and re-open the camera for no reason, and on some
      // devices that is slow enough to be noticed when a call comes in.
      if (localStreamRef.current) return localStreamRef.current;

      // Explicit rather than a bare `true`. Browser-side echo cancellation is
      // what keeps a call from howling when both devices sit close together and
      // each speaker feeds the other's microphone.
      const audioConstraints: MediaStreamConstraints["audio"] = audio
        ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        : false;

      // Ordered attempts rather than one request: preferring the rear camera
      // and surviving a device that has none are different asks, and one
      // getUserMedia call cannot satisfy both.
      const attempts: MediaStreamConstraints[] = [];
      if (video) {
        const base = { width: 1280, height: 720 };
        // Exact first for the rear camera. `ideal` is only a preference, so a
        // phone whose rear camera is busy can quietly hand back the front one,
        // which defeats the point of a phone propped up to show what it sees.
        // Exact would hard-fail instead, so the `ideal` attempt below keeps
        // tablets and laptops without a matching camera working.
        if (facing === "environment") {
          attempts.push({
            video: { ...base, facingMode: { exact: "environment" } },
            audio: audioConstraints,
          });
        }
        attempts.push({
          video: { ...base, facingMode: { ideal: facing } },
          audio: audioConstraints,
        });
      }
      // Audio-only is the last resort so a machine with no camera (the usual
      // desktop case) can still place a call. Skipped when there is no mic to
      // ask for: a constraints object with every field false is a TypeError,
      // not a recoverable device error.
      if (audio) {
        attempts.push({ video: false, audio: audioConstraints });
      }

      let stream: MediaStream | null = null;
      let lastError: unknown = null;
      for (const attempt of attempts) {
        try {
          stream = await navigator.mediaDevices.getUserMedia(attempt);
          break;
        } catch (err) {
          lastError = err;
          const name = err instanceof Error ? err.name : "";
          // Anything else is a genuine failure — a refused permission, most
          // importantly — and retrying it would only delay surfacing it.
          if (!DEVICE_MISSING.includes(name as (typeof DEVICE_MISSING)[number])) throw err;
        }
      }
      if (!stream) throw lastError;

      const hasVideo = stream.getVideoTracks().length > 0;
      // Only correct the flag when video was actually requested: a caller who
      // deliberately dialled in with the camera off still has working hardware,
      // and marking it unavailable would wrongly disable their camera control.
      if (video) {
        setCameraAvailable(hasVideo);
        if (!hasVideo) setVideoEnabledState(false);
      }

      localStreamRef.current = stream;
      // A fresh stream must honour the current choices, otherwise reopening the
      // mic after a hang-up would silently unmute.
      applyMicState(micEnabled);
      stream.getVideoTracks().forEach((t) => {
        t.enabled = videoEnabled;
      });
      bumpAttach();
      return stream;
    },
    [applyMicState, micEnabled, videoEnabled]
  );

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

  // Attach whatever we hold to whatever element is currently mounted. `armed`
  // matters as much as the tick: arming is what mounts the local preview, and
  // bumping the tick happens before that element exists.
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
  }, [attachTick, callState, armed]);

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
  const arm = useCallback(
    async (opts: GetLocalStreamOptions = {}): Promise<boolean> => {
      // Already armed: report success without re-opening a camera that is
      // already running, so an answer path can arm-then-answer unconditionally.
      if (armed) return true;

      try {
        await getLocalStream(opts);
        setPermission("granted");
        setArmed(true);
        void wakeLock.request();
        return true;
      } catch {
        setPermission("denied");
        setArmed(false);
        return false;
      }
    },
    [armed, getLocalStream, wakeLock]
  );

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
    videoEnabled,
    setVideoEnabled,
    cameraAvailable,
  };
}
