"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { doc, getDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import {
  observeAuth,
  signIn,
  signUp,
  signOutUser,
  observeReceivers,
  setApproved,
  isAuthConfigured,
  isReachable,
  type SessionUser,
  type ReceiverProfile,
} from "@/lib/auth";
import { startCall } from "@/lib/webrtc";
import { useVideoCall } from "@/hooks/useVideoCall";

/** Current build marker — bump when the receiver build changes. */
const CURRENT_BUILD = "2026.10.04";

type AuthGateState =
  | "checking"
  | "unconfigured"
  | "unauthenticated"
  | "not_admin"
  | "admin";

const page = "flex min-h-dvh items-center justify-center bg-surface-base px-4 py-8";
const card =
  "flex w-full max-w-md flex-col gap-6 rounded-xl border border-line bg-surface-card p-8 shadow-card animate-fade-in";
const rosterCard =
  "flex w-full max-w-3xl flex-col gap-4 rounded-xl border border-line bg-surface-card p-6 shadow-card animate-fade-in";
const spinner =
  "h-10 w-10 rounded-full border-2 border-teal-bg border-t-teal animate-spin";
const cta =
  "rounded-full bg-accent-gold px-6 py-3.5 text-base font-extrabold tracking-wide text-on-gold shadow-accent-glow transition-transform hover:bg-accent-gold-light";

export default function AdminPage() {
  // ── Auth gate ──
  const [authGate, setAuthGate] = useState<AuthGateState>("checking");
  const [adminUser, setAdminUser] = useState<SessionUser | null>(null);

  // ── Auth form ──
  const [authMode, setAuthMode] = useState<"signin" | "signup">("signin");
  const [formData, setFormData] = useState({ email: "", password: "", displayName: "" });
  const [authError, setAuthError] = useState("");
  const [authLoading, setAuthLoading] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const displayNameRef = useRef<HTMLInputElement>(null);

  // ── Roster ──
  const [receivers, setReceivers] = useState<ReceiverProfile[]>([]);
  const [rosterError, setRosterError] = useState("");
  const [selectedReceiverUid, setSelectedReceiverUid] = useState<string | null>(null);
  const [pendingApprovals, setPendingApprovals] = useState<Record<string, boolean>>({});

  // ── Call ──
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
    micEnabled,
    setMicEnabled,
    videoEnabled,
    setVideoEnabled,
    cameraAvailable,
    setActiveCall,
  } = useVideoCall();

  const isInCall = callState === "connecting" || callState === "connected";

  // ── Firebase config check ──
  const firebaseReady = isAuthConfigured();

  // ── Observe auth state ──
  useEffect(() => {
    if (!firebaseReady) {
      setAuthGate("unconfigured");
      return () => {};
    }
    const unsub = observeAuth((user) => {
      setAdminUser(user);
      if (!user) {
        setAuthGate("unauthenticated");
        return;
      }
      // Check admin doc
      getDoc(doc(db, "admins", user.uid)).then((snap) => {
        if (snap.exists()) {
          setAuthGate("admin");
        } else {
          setAuthGate("not_admin");
          signOutUser();
        }
      });
    });
    return unsub;
  }, [firebaseReady]);

  // ── Observe receivers ──
  useEffect(() => {
    if (authGate !== "admin") return;
    const unsub = observeReceivers((list) => {
      setReceivers(list);
      setRosterError("");
    });
    return unsub;
  }, [authGate]);

  // ── Focus email when auth screen appears ──
  useEffect(() => {
    if (authGate === "unauthenticated") {
      setTimeout(() => emailRef.current?.focus(), 0);
    }
  }, [authGate]);

  // ── Reset form when switching modes ──
  useEffect(() => {
    setFormData({ email: "", password: "", displayName: "" });
    setAuthError("");
  }, [authMode]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
    if (authError) setAuthError("");
  };

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (authLoading) return;

    const { email, password, displayName } = formData;
    if (!email.trim() || !password) return;
    if (authMode === "signup" && !displayName.trim()) return;

    setAuthLoading(true);
    setAuthError("");

    try {
      if (authMode === "signin") {
        await signIn(email.trim(), password);
      } else {
        await signUp(displayName.trim(), email.trim(), password);
      }
      // observeAuth will fire and transition us
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : "Terjadi kesalahan. Coba lagi.");
    } finally {
      setAuthLoading(false);
    }
  };

  const handleSignOut = async () => {
    if (isInCall) {
      try {
        await endCall();
      } catch {
        // Best-effort
      }
    }
    try {
      await signOutUser();
    } catch {
      // Ignore network errors
    }
    // observeAuth will fire and transition us
  };

  // ── Approve / revoke ──
  const handleToggleApproved = async (uid: string, currentApproved: boolean) => {
    setPendingApprovals((prev) => ({ ...prev, [uid]: true }));
    try {
      await setApproved(uid, !currentApproved);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Gagal mengubah status.";
      setRosterError(message);
      const live = document.getElementById("roster-live");
      if (live) live.textContent = message;
    } finally {
      setPendingApprovals((prev) => ({ ...prev, [uid]: false }));
    }
  };

  // ── Start call ──
  const handleCall = useCallback(async (receiverUid: string) => {
    if (!videoEnabled && !micEnabled) return;

    setSelectedReceiverUid(receiverUid);
    setCallState("connecting");

    let step = "initPeerConnection";
    try {
      const pc = initPC();
      step = "getLocalMedia";
      const localStream = await getLocalStream({
        video: videoEnabled,
        audio: micEnabled,
        facing: "user",
      });
      step = "addTrack";
      localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
      step = "startCall";
      const cleanup = await startCall(pc, setRemoteStream, receiverUid);
      cleanupRef.current = cleanup;

      // Read back the callId from the room document so endCall can hang up the right call
      const roomSnap = await getDoc(doc(db, "rooms", receiverUid));
      const callId = roomSnap.data()?.callId;
      if (callId) {
        setActiveCall(receiverUid, callId);
      }
    } catch (err) {
      const name = err instanceof Error ? err.name : typeof err;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[admin] gagal pada langkah: ${step}`, { step, name, message, err });
      setCallState("error");
      setSelectedReceiverUid(null);
    }
  }, [initPC, getLocalStream, setRemoteStream, setCallState, cleanupRef, videoEnabled, micEnabled, setActiveCall]);

  // ── Render helpers ──

  // Loading session check
  if (authGate === "checking") {
    return (
      <div className={page}>
        <div className={card}>
          <div className={spinner} aria-hidden="true" />
          <p className="text-sm text-ink-dim">Memeriksa sesi…</p>
        </div>
      </div>
    );
  }

  // Firebase not configured
  if (authGate === "unconfigured" || !firebaseReady) {
    const missingVars = [
      "NEXT_PUBLIC_FIREBASE_API_KEY",
      "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
      "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
      "NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET",
      "NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID",
      "NEXT_PUBLIC_FIREBASE_APP_ID",
    ].filter((key) => !process.env[key]);

    return (
      <div className={page}>
        <div className={`${card} items-stretch`}>
          <div className="mx-auto grid h-16 w-16 place-items-center rounded-lg bg-coral/15 text-coral-dark shadow-coral-glow">
            <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          </div>
          <h1 className="text-center text-2xl font-extrabold tracking-tight text-brand">
            Belum Dikonfigurasi
          </h1>
          <p className="text-center text-sm text-ink-dim">
            Variabel lingkungan Firebase berikut belum disetel:
          </p>
          <ul className="space-y-2">
            {missingVars.map((v) => (
              <li
                key={v}
                className="accent-bar-coral rounded-md bg-coral/10 px-3 py-2 font-mono text-sm text-coral-light"
              >
                {v}
              </li>
            ))}
          </ul>
          <p className="text-center text-xs leading-relaxed text-ink-muted">
            Tambahkan variabel tersebut ke{" "}
            <code className="rounded-sm bg-teal-bg px-1 py-0.5 font-mono text-teal-dark">
              .env.local
            </code>{" "}
            dan restart server.
          </p>
        </div>
      </div>
    );
  }

  // Not authenticated — show sign in / sign up
  if (authGate === "unauthenticated") {
    const isSignup = authMode === "signup";

    return (
      <div className={page}>
        <form onSubmit={handleAuthSubmit} noValidate className={card}>
          <div className="flex flex-col items-center gap-4 text-center">
            <div className="grid h-16 w-16 place-items-center rounded-lg bg-teal-bg text-teal-dark shadow-teal-glow">
              <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            </div>
            <div className="space-y-2">
              <h1 className="text-3xl font-extrabold tracking-tight text-brand">
                VConnect
              </h1>
              <p className="text-sm text-ink-dim">
                {isSignup ? "Daftar sebagai admin baru" : "Masuk untuk mengelola receiver"}
              </p>
            </div>
          </div>

          <div className="divider-dashed" />

          {/* Mode toggle tabs */}
          <div className="flex gap-2" role="tablist" aria-label="Pilih mode">
            <button
              type="button"
              role="tab"
              aria-selected={!isSignup}
              aria-controls="signin-panel"
              id="signin-tab"
              onClick={() => setAuthMode("signin")}
              className={`flex-1 rounded-md px-4 py-3 text-sm font-bold uppercase tracking-widest transition-colors ${
                !isSignup
                  ? "bg-teal-bg text-teal-dark shadow-teal-glow"
                  : "bg-surface-card border border-line text-ink-dim hover:border-brand hover:text-brand"
              }`}
            >
              Masuk
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={isSignup}
              aria-controls="signup-panel"
              id="signup-tab"
              onClick={() => setAuthMode("signup")}
              className={`flex-1 rounded-md px-4 py-3 text-sm font-bold uppercase tracking-widest transition-colors ${
                isSignup
                  ? "bg-teal-bg text-teal-dark shadow-teal-glow"
                  : "bg-surface-card border border-line text-ink-dim hover:border-brand hover:text-brand"
              }`}
            >
              Daftar
            </button>
          </div>

          {/* Sign in panel */}
          <div
            id="signin-panel"
            role="tabpanel"
            aria-labelledby="signin-tab"
            hidden={isSignup}
            className="space-y-4"
          >
            <div className="space-y-2">
              <label htmlFor="email" className="text-xs font-bold uppercase tracking-widest text-ink-dim block">
                Email
              </label>
              <input
                id="email"
                ref={emailRef}
                type="email"
                autoComplete="email"
                name="email"
                value={formData.email}
                onChange={handleInputChange}
                required
                disabled={authLoading}
                className="w-full rounded-md border-2 border-line bg-surface-input py-4 px-4 text-base text-ink placeholder:text-ink-muted/40 disabled:opacity-50 transition-colors focus:border-brand focus:shadow-teal-glow focus:outline-none"
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="password" className="text-xs font-bold uppercase tracking-widest text-ink-dim block">
                PIN
              </label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                name="password"
                value={formData.password}
                onChange={handleInputChange}
                required
                disabled={authLoading}
                className="w-full rounded-md border-2 border-line bg-surface-input py-4 px-4 text-base text-ink placeholder:text-ink-muted/40 disabled:opacity-50 transition-colors focus:border-brand focus:shadow-teal-glow focus:outline-none"
              />
            </div>
          </div>

          {/* Sign up panel */}
          <div
            id="signup-panel"
            role="tabpanel"
            aria-labelledby="signup-tab"
            hidden={!isSignup}
            className="space-y-4"
          >
            <div className="space-y-2">
              <label htmlFor="displayName" className="text-xs font-bold uppercase tracking-widest text-ink-dim block">
                Nama tampilan
              </label>
              <input
                id="displayName"
                ref={displayNameRef}
                type="text"
                autoComplete="name"
                name="displayName"
                value={formData.displayName}
                onChange={handleInputChange}
                required
                disabled={authLoading}
                className="w-full rounded-md border-2 border-line bg-surface-input py-4 px-4 text-base text-ink placeholder:text-ink-muted/40 disabled:opacity-50 transition-colors focus:border-brand focus:shadow-teal-glow focus:outline-none"
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="email-signup" className="text-xs font-bold uppercase tracking-widest text-ink-dim block">
                Email
              </label>
              <input
                id="email-signup"
                type="email"
                autoComplete="email"
                name="email"
                value={formData.email}
                onChange={handleInputChange}
                required
                disabled={authLoading}
                className="w-full rounded-md border-2 border-line bg-surface-input py-4 px-4 text-base text-ink placeholder:text-ink-muted/40 disabled:opacity-50 transition-colors focus:border-brand focus:shadow-teal-glow focus:outline-none"
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="password-signup" className="text-xs font-bold uppercase tracking-widest text-ink-dim block">
                PIN
              </label>
              <input
                id="password-signup"
                type="password"
                autoComplete="new-password"
                name="password"
                value={formData.password}
                onChange={handleInputChange}
                required
                minLength={6}
                disabled={authLoading}
                className="w-full rounded-md border-2 border-line bg-surface-input py-4 px-4 text-base text-ink placeholder:text-ink-muted/40 disabled:opacity-50 transition-colors focus:border-brand focus:shadow-teal-glow focus:outline-none"
              />
            </div>
          </div>

          {authError && (
            <p
              role="alert"
              aria-live="assertive"
              className="accent-bar-coral rounded-md bg-coral/12 px-4 py-3 text-sm font-medium text-coral-light text-center"
            >
              {authError}
            </p>
          )}

          {rosterError && (
            <p
              id="roster-live"
              role="alert"
              aria-live="assertive"
              className="accent-bar-coral rounded-md bg-coral/12 px-4 py-3 text-sm font-medium text-coral-light text-center"
            >
              {rosterError}
            </p>
          )}

          <button
            type="submit"
            disabled={authLoading || !formData.email.trim() || !formData.password || (isSignup && !formData.displayName.trim())}
            aria-busy={authLoading}
            className={`${cta} w-full disabled:hover:bg-accent-gold`}
          >
            {authLoading
              ? isSignup
                ? "Mendaftarkan…"
                : "Memeriksa…"
              : isSignup
              ? "Daftar"
              : "Masuk"}
          </button>

          <p className="text-center text-xs text-ink-muted">
            {isSignup ? "Sudah punya akun? " : "Belum punya akun? "}
            <button
              type="button"
              onClick={() => setAuthMode(isSignup ? "signin" : "signup")}
              className="font-bold text-brand hover:underline"
            >
              {isSignup ? "Masuk" : "Daftar"}
            </button>
          </p>
        </form>
      </div>
    );
  }

  // Not an admin
  if (authGate === "not_admin") {
    return (
      <div className={page}>
        <div className={`${card} items-stretch text-center`}>
          <div className="mx-auto grid h-16 w-16 place-items-center rounded-lg bg-coral/15 text-coral-dark shadow-coral-glow">
            <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
              <circle cx="12" cy="12" r="10" />
              <line x1="15" y1="9" x2="9" y2="15" />
              <line x1="9" y1="9" x2="15" y2="15" />
            </svg>
          </div>
          <h1 className="text-2xl font-extrabold tracking-tight text-brand">
            Anda Bukan Admin
          </h1>
          <p className="text-sm text-ink-dim">
            Akun ini tidak memiliki akses admin.
          </p>
          <button
            onClick={handleSignOut}
            className="rounded-full border border-line bg-surface-card px-6 py-3 text-base font-bold tracking-wide text-ink transition-colors hover:border-coral hover:text-coral-light"
          >
            Keluar
          </button>
        </div>
      </div>
    );
  }

  // ── Admin view: roster + call UI ──
  return (
    <div className="relative h-dvh w-full overflow-hidden bg-surface-base text-ink">
      <video ref={remoteVideoRef} autoPlay playsInline className="h-full w-full object-cover" />

      {/* Local PiP during call */}
      {isInCall && videoEnabled && cameraAvailable && (
        <video
          ref={localVideoRef}
          autoPlay
          playsInline
          muted
          className="absolute bottom-5 right-5 aspect-[4/3] w-32 rounded-lg border-2 border-surface-card object-cover shadow-md transition-opacity duration-200 opacity-100"
        />
      )}

      <header className="absolute inset-x-0 top-0 z-20 flex items-center justify-between px-4 py-3">
        <span className="rounded-full border border-line bg-surface-card/90 px-4 py-1.5 text-xs font-bold uppercase tracking-widest text-brand shadow-sm">
          Admin
        </span>
        <button
          onClick={handleSignOut}
          aria-label="Keluar"
          title="Keluar"
          className="grid h-12 w-12 place-items-center rounded-full border border-line bg-surface-card/90 text-ink-dim shadow-sm transition-colors hover:border-coral hover:text-coral-light"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
        </button>
      </header>

      {/* Roster panel — shown when not in a call */}
      {!isInCall && callState !== "error" && (
        <div className="absolute inset-0 flex items-center justify-center px-4 py-16">
          <div className={rosterCard}>
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-extrabold tracking-tight text-brand">
                Receiver
              </h2>
              <span className="text-xs text-ink-muted font-mono">
                {receivers.length} perangkat
              </span>
            </div>

            {rosterError && (
              <p
                id="roster-live"
                role="alert"
                aria-live="assertive"
                className="accent-bar-coral rounded-md bg-coral/12 px-4 py-3 text-sm font-medium text-coral-light"
              >
                {rosterError}
              </p>
            )}

            {receivers.length === 0 ? (
              <div className="py-8 text-center text-ink-dim">
                <p>Belum ada receiver terdaftar.</p>
                <p className="text-xs mt-1">Receiver akan muncul di sini setelah mendaftar.</p>
              </div>
            ) : (
              <ul className="space-y-3 max-h-[50vh] overflow-y-auto pr-1" role="list" aria-label="Daftar receiver">
                {receivers.map((r) => {
                  const reachable = isReachable(r);
                  const stale = r.online && !reachable;
                  const isSelected = selectedReceiverUid === r.uid;
                  const isPending = pendingApprovals[r.uid];
                  const canCall = r.approved;
                  const needsUpdate = r.approved && (!r.build || r.build !== CURRENT_BUILD);

                  return (
                    <li
                      key={r.uid}
                      className={`relative flex items-center gap-3 rounded-lg border p-3 transition-colors ${
                        isSelected ? "bg-teal-bg/10 border-teal-bg" : "border-line hover:border-brand/50"
                      }`}
                    >
                      {/* Presence indicator */}
                      <span
                        className={`relative shrink-0 h-3 w-3 rounded-full ${
                          reachable
                            ? "bg-emerald-500 shadow-[0_0_0_2px_rgb(16_185_129)]"
                            : stale
                            ? "bg-amber-500 shadow-[0_0_0_2px_rgb(245_158_11)]"
                            : "bg-ink-muted"
                        }`}
                        aria-label={
                          reachable
                            ? "Dapat dijangkau"
                            : stale
                            ? "Online tapi tidak merespons (stale)"
                            : "Offline"
                        }
                      />

                      {/* Info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-ink truncate">{r.displayName}</span>
                          {r.approved && (
                            <span className="shrink-0 rounded-full bg-teal-bg px-2 py-0.5 text-xs font-bold text-teal-dark">
                              Disetujui
                            </span>
                          )}
                          {!r.approved && (
                            <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-700">
                              Menunggu persetujuan
                            </span>
                          )}
                          {needsUpdate && (
                            <span className="shrink-0 rounded-full bg-coral/15 px-2 py-0.5 text-xs font-bold text-coral-light">
                              Perlu update
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 text-xs text-ink-dim flex-wrap">
                          <span className="truncate font-mono">{r.email}</span>
                          <span aria-hidden="true">·</span>
                          <span>
                            {reachable
                              ? "Dapat dijangkau"
                              : stale
                              ? "Online tapi tidak merespons"
                              : "Offline"}
                          </span>
                          {r.createdAt && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="font-mono">
                                Build:{" "}
                                {(r as ReceiverProfile & { build?: string }).build ?? "—"}
                              </span>
                            </>
                          )}
                        </div>
                      </div>

                      {/* Actions */}
                      <div className="flex items-center gap-2 flex-wrap">
                        {/* Approve / Revoke */}
                        {!r.approved ? (
                          <button
                            onClick={() => handleToggleApproved(r.uid, false)}
                            disabled={isPending}
                            aria-busy={isPending}
                            aria-pressed={false}
                            aria-label={`Setujui ${r.displayName}`}
                            className="rounded-md bg-teal-bg px-3 py-1.5 text-sm font-bold text-teal-dark shadow-teal-glow transition-colors hover:bg-teal-bg/90 disabled:opacity-50 disabled:cursor-wait"
                          >
                            {isPending ? "Menyetujui…" : "Setujui"}
                          </button>
                        ) : (
                          <button
                            onClick={() => handleToggleApproved(r.uid, true)}
                            disabled={isPending}
                            aria-busy={isPending}
                            aria-pressed={true}
                            aria-label={`Cabut persetujuan ${r.displayName}`}
                            className="rounded-md border border-line bg-surface-card px-3 py-1.5 text-sm font-bold text-ink-dim transition-colors hover:border-coral hover:text-coral-light disabled:opacity-50 disabled:cursor-wait"
                          >
                            {isPending ? "Mencabut…" : "Cabut"}
                          </button>
                        )}

                        {/* Call button */}
                        {canCall && (
                          <button
                            onClick={() => handleCall(r.uid)}
                            disabled={isInCall}
                            aria-busy={false}
                            aria-pressed={isSelected}
                            aria-label={isSelected ? `Batalkan panggilan ke ${r.displayName}` : `Panggil ${r.displayName}`}
                            className={`rounded-full px-4 py-2 text-sm font-bold tracking-wide transition-colors ${
                              isSelected
                                ? "bg-coral text-on-coral shadow-coral-glow"
                                : "bg-accent-gold text-on-gold shadow-accent-glow hover:bg-accent-gold-light"
                            } disabled:opacity-50 disabled:cursor-not-allowed`}
                          >
                            {isSelected ? "Batalkan" : "Panggil"}
                          </button>
                        )}

                        {!canCall && (
                          <span className="px-3 py-1.5 text-xs font-medium text-ink-muted">
                            Belum disetujui
                          </span>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            {/* Pre-call device toggles */}
            <div className="border-t border-line pt-4">
              <div className="flex items-center justify-center gap-4">
                <button
                  onClick={() => setVideoEnabled(!videoEnabled)}
                  disabled={!cameraAvailable}
                  aria-label={videoEnabled ? "Matikan kamera" : "Aktifkan kamera"}
                  aria-pressed={videoEnabled}
                  className={`grid h-12 w-12 place-items-center rounded-full border-2 transition-colors focus:outline-none focus:ring-2 focus:ring-brand ${
                    cameraAvailable
                      ? videoEnabled
                        ? "bg-surface-card border-teal-bg text-teal-bg hover:bg-teal-bg/10"
                        : "bg-surface-card border-line text-ink-dim hover:border-brand hover:text-brand"
                        : "bg-surface-card/50 border-line/50 text-ink-muted cursor-not-allowed"
                  }`}
                >
                  {videoEnabled ? (
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                      <circle cx="12" cy="13" r="4" />
                    </svg>
                  ) : (
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                      <line x1="1" y1="1" x2="23" y2="23" />
                    </svg>
                  )}
                </button>

                <button
                  onClick={() => setMicEnabled(!micEnabled)}
                  aria-label={micEnabled ? "Matikan mikrofon" : "Aktifkan mikrofon"}
                  aria-pressed={micEnabled}
                  className={`grid h-12 w-12 place-items-center rounded-full border-2 transition-colors focus:outline-none focus:ring-2 focus:ring-brand ${
                    micEnabled
                      ? "bg-surface-card border-teal-bg text-teal-bg hover:bg-teal-bg/10"
                      : "bg-surface-card border-line text-ink-dim hover:border-brand hover:text-brand"
                  }`}
                >
                  {micEnabled ? (
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                      <line x1="12" y1="19" x2="12" y2="22" />
                    </svg>
                  ) : (
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                      <line x1="1" y1="1" x2="23" y2="23" />
                      <line x1="12" y1="19" x2="12" y2="22" />
                    </svg>
                  )}
                </button>
              </div>

              {!cameraAvailable && (
                <p className="text-center text-xs text-ink-muted mt-2">
                  Kamera tidak tersedia — panggilan akan berjalan dengan mikrofon saja.
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Connecting */}
      {callState === "connecting" && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 bg-surface-base/90 text-center">
          <div className={spinner} aria-hidden="true" />
          <div className="space-y-1">
            <p className="text-sm font-bold text-ink">Menghubungi receiver…</p>
            <p className="text-xs text-ink-muted">Menunggu receiver menjawab</p>
            {selectedReceiverUid && (
              <button
                onClick={() => {
                  setCallState("idle");
                  setSelectedReceiverUid(null);
                }}
                className="mt-2 rounded-full border border-line bg-surface-card px-4 py-2 text-sm font-bold text-ink transition-colors hover:border-coral hover:text-coral-light"
              >
                Batalkan
              </button>
            )}
          </div>
        </div>
      )}

      {/* Error */}
      {callState === "error" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 bg-surface-base px-6 text-center">
          <p className="accent-bar-coral rounded-md bg-coral/12 px-4 py-3 text-sm font-medium text-coral-light">
            Koneksi gagal.
          </p>
          <button onClick={() => handleCall(selectedReceiverUid!)} className={cta}>
            Coba Lagi
          </button>
        </div>
      )}

      {/* Ended */}
      {callState === "ended" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 bg-surface-base px-6 text-center">
          <p className="text-sm text-ink-dim">Panggilan selesai.</p>
          <button onClick={() => handleCall(selectedReceiverUid!)} className={cta}>
            Panggil Lagi
          </button>
        </div>
      )}

      {/* In-call controls */}
      {isInCall && (
        <div className="absolute inset-x-0 bottom-8 z-30 flex justify-center gap-4 px-4">
          <button
            onClick={() => setVideoEnabled(!videoEnabled)}
            disabled={!cameraAvailable}
            aria-label={videoEnabled ? "Matikan kamera" : "Aktifkan kamera"}
            aria-pressed={videoEnabled}
            className={`grid h-14 w-14 place-items-center rounded-full border-2 transition-colors focus:outline-none focus:ring-2 focus:ring-brand ${
              cameraAvailable
                ? videoEnabled
                  ? "bg-surface-card/90 border-teal-bg text-teal-bg hover:bg-teal-bg/10"
                  : "bg-surface-card/90 border-line text-ink-dim hover:border-brand hover:text-brand"
                  : "bg-surface-card/50 border-line/50 text-ink-muted cursor-not-allowed"
            }`}
          >
            {videoEnabled ? (
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                <circle cx="12" cy="13" r="4" />
              </svg>
            ) : (
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                <line x1="1" y1="1" x2="23" y2="23" />
              </svg>
            )}
          </button>

          <button
            onClick={() => setMicEnabled(!micEnabled)}
            aria-label={micEnabled ? "Matikan mikrofon" : "Aktifkan mikrofon"}
            aria-pressed={micEnabled}
            className={`grid h-14 w-14 place-items-center rounded-full border-2 transition-colors focus:outline-none focus:ring-2 focus:ring-brand ${
              micEnabled
                ? "bg-surface-card/90 border-teal-bg text-teal-bg hover:bg-teal-bg/10"
                : "bg-surface-card/90 border-line text-ink-dim hover:border-brand hover:text-brand"
            }`}
          >
            {micEnabled ? (
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="12" y1="19" x2="12" y2="22" />
              </svg>
            ) : (
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="1" y1="1" x2="23" y2="23" />
                <line x1="12" y1="19" x2="12" y2="22" />
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
      )}
    </div>
  );
}