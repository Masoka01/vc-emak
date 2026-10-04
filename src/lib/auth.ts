import {
  createUserWithEmailAndPassword,
  deleteUser,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  updateProfile,
  type User,
} from "firebase/auth";
import {
  collection,
  doc,
  onSnapshot,
  setDoc,
  updateDoc,
} from "firebase/firestore";
import { auth, db } from "./firebase";

/**
 * Firebase Auth for the receiver accounts, and the presence signal the admin
 * uses to see who is reachable.
 *
 * Everything here degrades to a readable error instead of throwing a raw
 * Firebase code at the UI, because these are all user-facing failure modes:
 * a mistyped password, a duplicate address, a flaky network.
 *
 * Presence is best-effort by necessity. Firestore has no onDisconnect, so a
 * receiver whose tab crashes or loses power leaves online=true behind. The
 * heartbeat below exists so that state goes stale on its own: admin treats a
 * receiver as reachable only when `online && now - lastSeen < STALE_MS`.
 */

export type SessionUser = {
  uid: string;
  email: string;
  displayName: string;
};

export type ReceiverProfile = {
  uid: string;
  displayName: string;
  email: string;
  approved: boolean;
  online: boolean;
  lastSeen: number;
  createdAt: number;
  /**
   * Version marker the receiver writes on sign-in. It is the only way an admin
   * can tell a tablet that is genuinely offline from one that is online but
   * still running code that rings the retired shared room — the failure this
   * app is most likely to hit in the field.
   */
  build?: string;
};

/** How often a signed-in receiver refreshes lastSeen. */
export const HEARTBEAT_MS = 60_000;

/**
 * How stale lastSeen may be before a receiver stops counting as reachable.
 * Two heartbeats, so one dropped write does not make a live device look gone.
 */
export const STALE_MS = 120_000;

export function isAuthConfigured(): boolean {
  return auth !== null;
}

/** Firebase error codes as something a person can act on. */
function authErrorMessage(err: unknown): string {
  const code =
    err && typeof err === "object" && "code" in err
      ? String((err as { code: unknown }).code)
      : "";
  switch (code) {
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found":
      return "Email atau kata sandi salah.";
    case "auth/email-already-in-use":
      return "Email itu sudah terdaftar. Coba masuk saja.";
    case "auth/invalid-email":
      return "Format email tidak valid.";
    case "auth/weak-password":
      return "Kata sandi terlalu lemah. Pakai minimal 6 karakter.";
    case "auth/too-many-requests":
      return "Terlalu banyak percobaan. Tunggu sebentar lalu coba lagi.";
    case "auth/network-request-failed":
      return "Koneksi ke server gagal. Cek jaringanmu.";
    case "auth/user-disabled":
      return "Akun ini dinonaktifkan.";
    default:
      return "Terjadi kesalahan. Coba lagi.";
  }
}

/** Raised for conditions we can name better than Firebase can. */
export class AuthError extends Error {}

function requireAuth() {
  if (!auth) {
    throw new AuthError("Firebase Auth belum dikonfigurasi.");
  }
  return auth;
}

function toSessionUser(user: { uid: string; email: string | null; displayName: string | null } | null): SessionUser | null {
  if (!user) return null;
  return {
    uid: user.uid,
    email: user.email ?? "",
    // Firebase leaves displayName null unless a profile was set, and a receiver
    // choosing their own name is the whole point of the field.
    displayName: user.displayName || user.email?.split("@")[0] || "Receiver",
  };
}

export function currentUser(): SessionUser | null {
  return toSessionUser(auth?.currentUser ?? null);
}

/**
 * Watch the signed-in user. Fires once immediately with the current state, so a
 * page can render from it without a separate "is it still loading" read.
 */
export function observeAuth(onChange: (user: SessionUser | null) => void): () => void {
  if (!auth) {
    onChange(null);
    return () => {};
  }
  return onAuthStateChanged(auth, (user) => onChange(toSessionUser(user)));
}

export async function signIn(email: string, password: string): Promise<SessionUser> {
  try {
    const cred = await signInWithEmailAndPassword(requireAuth(), email, password);
    const user = toSessionUser(cred.user);
    if (!user) throw new AuthError("Gagal masuk.");
    return user;
  } catch (err) {
    throw new AuthError(authErrorMessage(err));
  }
}

/**
 * Create the account and its profile in one step.
 *
 * The profile is written with approved:false, and the rules refuse any write
 * that tries to change `approved` from the owner's own session — so a receiver
 * cannot approve themselves by hand-editing a request.
 */
export async function signUp(
  displayName: string,
  email: string,
  password: string
): Promise<SessionUser> {
  const name = displayName.trim();
  if (!name) throw new AuthError("Nama tampilan wajib diisi.");

  // Tracked separately from the try block so a failure inside
  // createUserWithEmailAndPassword itself never triggers a delete: there is
  // no account to roll back until that call has returned.
  let createdUser: User | null = null;
  try {
    const cred = await createUserWithEmailAndPassword(requireAuth(), email, password);
    createdUser = cred.user;
    await updateProfile(cred.user, { displayName: name });
    await setDoc(doc(db, "users", cred.user.uid), {
      displayName: name,
      email: cred.user.email ?? email,
      approved: false,
      online: true,
      lastSeen: Date.now(),
      createdAt: Date.now(),
    });
    return { uid: cred.user.uid, email: cred.user.email ?? "", displayName: name };
  } catch (err) {
    if (createdUser) {
      // The Auth account exists but its profile write failed, which would
      // strand the email as "already registered" with no usable profile.
      // Delete it so the user can simply register again. Best-effort: a
      // failed rollback must not mask the original, understandable message.
      try {
        await deleteUser(createdUser);
      } catch {
        // Ignore: the user-facing error below is what matters.
      }
      throw new AuthError("Pendaftaran gagal disimpan. Silakan coba daftar lagi.");
    }
    throw new AuthError(authErrorMessage(err));
  }
}

export async function signOutUser(): Promise<void> {
  await requireAuth().signOut();
}

export function userDoc(uid: string) {
  return doc(db, "users", uid);
}

function toProfile(uid: string, data: Record<string, unknown>): ReceiverProfile {
  return {
    uid,
    displayName: String(data.displayName ?? "Receiver"),
    email: String(data.email ?? ""),
    approved: data.approved === true,
    online: data.online === true,
    lastSeen: Number(data.lastSeen ?? 0),
    createdAt: Number(data.createdAt ?? 0),
    build: data.build === undefined ? undefined : String(data.build),
  };
}

/** Live view of one receiver's profile. */
export function observeProfile(
  uid: string,
  onChange: (profile: ReceiverProfile | null) => void
): () => void {
  return onSnapshot(userDoc(uid), (snap) => {
    if (!snap.exists()) {
      onChange(null);
      return;
    }
    onChange(toProfile(uid, snap.data() as Record<string, unknown>));
  });
}

/** Live view of every registered receiver, for the admin list. */
export function observeReceivers(
  onChange: (profiles: ReceiverProfile[]) => void
): () => void {
  return onSnapshot(collection(db, "users"), (snap) => {
    const out: ReceiverProfile[] = [];
    snap.forEach((d) => out.push(toProfile(d.id, d.data() as Record<string, unknown>)));
    // Newest first: the receiver who just registered is the one the admin is
    // most likely to be looking at.
    out.sort((a, b) => b.createdAt - a.createdAt);
    onChange(out);
  }, () => onChange([]));
}

export async function setApproved(uid: string, approved: boolean): Promise<void> {
  await updateDoc(userDoc(uid), { approved });
}

/** Whether a profile still counts as reachable, given heartbeat staleness. */
export function isReachable(profile: ReceiverProfile, now = Date.now()): boolean {
  return profile.online && now - profile.lastSeen < STALE_MS;
}

/**
 * Mark the receiver online and keep lastSeen fresh until the returned cleanup
 * runs.
 *
 * The pagehide write is best-effort: a browser may drop it on mobile when the
 * tab is discarded. That is exactly why staleness, rather than the online flag
 * alone, is what the admin relies on.
 */
export function startPresence(uid: string): () => void {
  const beat = () => {
    void setDoc(
      userDoc(uid),
      { online: true, lastSeen: Date.now() },
      { merge: true }
    ).catch(() => {});
  };

  beat();
  const timer = setInterval(beat, HEARTBEAT_MS);

  const goOffline = () => {
    void setDoc(userDoc(uid), { online: false }, { merge: true }).catch(() => {});
  };
  window.addEventListener("pagehide", goOffline);

  return () => {
    clearInterval(timer);
    window.removeEventListener("pagehide", goOffline);
    goOffline();
  };
}

/**
 * Publish the running client version, plus the account email, on the receiver's
 * own profile.
 *
 * Both fields are safe for a receiver to write because the rules let a user
 * update their own document as long as `approved` is left alone. The email is
 * included here rather than only at sign-up so that accounts created before this
 * field existed are backfilled the next time their tablet loads this build.
 */
export async function publishBuild(uid: string, build: string): Promise<void> {
  const user = currentUser();
  await setDoc(
    userDoc(uid),
    { build, email: user?.email ?? "" },
    { merge: true }
  );
}