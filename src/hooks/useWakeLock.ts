"use client";
import { useCallback, useEffect, useRef, useState } from "react";

// Minimal shape of the Screen Wake Lock sentinel. Declared locally so the file
// type-checks without depending on lib.dom's WakeLockSentinel being present.
type WakeLockSentinelLike = {
  released: boolean;
  release: () => Promise<void>;
  addEventListener: (type: "release", listener: () => void) => void;
};

type NavigatorWithWakeLock = Navigator & {
  wakeLock?: { request: (type: "screen") => Promise<WakeLockSentinelLike> };
};

/**
 * Keeps the device screen on for as long as the caller wants it.
 *
 * The browser revokes the lock on its own whenever the tab is hidden or the
 * screen turns off, so holding the sentinel is not enough: we have to listen
 * for visibility and ask again. `wantRef` is what separates "the user asked to
 * stay awake" from "we happen to hold a lock right now" — without it, coming
 * back from a hidden tab would either never reacquire or reacquire after an
 * explicit release.
 */
export function useWakeLock() {
  const [active, setActive] = useState(false);
  const sentinelRef = useRef<WakeLockSentinelLike | null>(null);
  const wantRef = useRef(false);

  const release = useCallback(async () => {
    const sentinel = sentinelRef.current;
    sentinelRef.current = null;
    setActive(false);
    if (sentinel && !sentinel.released) {
      try {
        await sentinel.release();
      } catch {
        // Already gone; nothing to clean up.
      }
    }
  }, []);

  const request = useCallback(async () => {
    if (sentinelRef.current) return;

    const wakeLock = (navigator as NavigatorWithWakeLock).wakeLock;
    if (!wakeLock) return; // Unsupported browser: degrade silently, never throw.

    try {
      const sentinel = await wakeLock.request("screen");
      sentinelRef.current = sentinel;
      setActive(true);

      sentinel.addEventListener("release", () => {
        // The browser took the lock away (tab switch, screen off). Drop our
        // handle so the next visibilitychange can request a fresh one.
        if (sentinelRef.current === sentinel) sentinelRef.current = null;
        setActive(false);
      });
    } catch {
      // Denied or the page is not visible yet. Stay off rather than throwing at
      // a tap handler.
      setActive(false);
    }
  }, []);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible" && wantRef.current) {
        void request();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [request]);

  useEffect(
    () => () => {
      wantRef.current = false;
      void release();
    },
    [release]
  );

  const acquire = useCallback(async () => {
    wantRef.current = true;
    await request();
  }, [request]);

  const stop = useCallback(async () => {
    wantRef.current = false;
    await release();
  }, [release]);

  return { active, request: acquire, release: stop };
}
