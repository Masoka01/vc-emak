import {
  doc,
  setDoc,
  getDoc,
  onSnapshot,
  collection,
  addDoc,
  deleteDoc,
  getDocs,
} from "firebase/firestore";
import { db } from "./firebase";
import { getRoomId } from "./env";

// No public fallback: a guessable default room id would defeat the point of a
// private intercom.
const ROOM_ID = getRoomId();

// STUN servers publik (Google)
const ICE_SERVERS: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

export function createPeerConnection(): RTCPeerConnection {
  return new RTCPeerConnection(ICE_SERVERS);
}

// ─── CALL IDENTITY ───────────────────────────────────────────────────────────

// The call currently live on this client. A page cannot be in two calls at
// once, so this does not need threading through every caller.
let activeCallId: string | null = null;

function newCallId(): string {
  return `${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

// A rejected write here is a normal race in a one-caller-one-receiver call, not
// a failure worth putting in front of either person.
function isPermissionDenied(err: unknown): boolean {
  return err instanceof Error && /permission-denied/i.test(err.message);
}

// ─── CALLER (ADMIN) ──────────────────────────────────────────────────────────

export async function startCall(
  pc: RTCPeerConnection,
  onRemoteStream: (stream: MediaStream) => void
): Promise<() => void> {
  const roomRef = doc(db, "rooms", ROOM_ID);

  // Every call gets its own identity, and every write below carries it. That is
  // what lets the rules tell "the receiver answering this call" apart from "a
  // late answer to the previous call that arrived after a new one had begun".
  const callId = newCallId();
  activeCallId = callId;

  // Clear the last call's ICE candidates. Deliberately NOT deleting the room
  // document: a deleted room document fires the receiver's watcher, which tears
  // down its peer connection, and that window between delete and re-create is
  // where calls used to kill themselves.
  await clearCandidates();

  // Tangkap ICE candidates caller
  const callerCandidates = collection(roomRef, "callerCandidates");
  pc.onicecandidate = (e) => {
    if (e.candidate) addDoc(callerCandidates, { ...e.candidate.toJSON(), callId });
  };

  // Remote stream
  pc.ontrack = (e) => {
    if (e.streams[0]) onRemoteStream(e.streams[0]);
  };

  // Buat offer
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  await setDoc(roomRef, {
    callId,
    offer: { type: offer.type, sdp: offer.sdp },
    status: "calling",
    createdAt: Date.now(),
  });

  // Dengarkan answer dari receiver
  const unsubRoom = onSnapshot(roomRef, async (snap) => {
    const data = snap.data();
    // Ignore any answer belonging to a call that is no longer ours.
    if (data?.callId !== callId) return;
    if (data?.answer && !pc.currentRemoteDescription) {
      await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
    }
  });

  // Dengarkan ICE candidates dari receiver
  const receiverCandidates = collection(roomRef, "receiverCandidates");
  const unsubCandidates = onSnapshot(receiverCandidates, (snap) => {
    snap.docChanges().forEach((change) => {
      if (change.type === "added") {
        // Drop candidates left over from a call this connection never took part
        // in. Handing one to addIceCandidate fails the connection we are trying
        // to protect.
        if (change.doc.data().callId !== callId) return;
        pc.addIceCandidate(new RTCIceCandidate(change.doc.data()));
      }
    });
  });

  return () => {
    unsubRoom();
    unsubCandidates();
  };
}

// ─── RECEIVER ────────────────────────────────────────────────────────────────

export function listenForCall(
  onStatusChange: (incoming: boolean, callId: string | null) => void
): () => void {
  const roomRef = doc(db, "rooms", ROOM_ID);
  return onSnapshot(roomRef, (snap) => {
    const data = snap.data();
    // Report both directions. An incoming-call indicator has to be able to
    // disappear when the caller gives up, and giving up never produces another
    // "calling" event — it produces the absence of one.
    const incoming = Boolean(data?.status === "calling" && data?.offer);
    // Hand back the call id too, so the receiver can ignore a call it has already
    // answered instead of answering it a second time.
    onStatusChange(incoming, incoming ? (data?.callId ?? null) : null);
  });
}

export async function answerCall(
  pc: RTCPeerConnection,
  onRemoteStream: (stream: MediaStream) => void,
  callId: string,
  onRemoteHangup?: () => void
): Promise<() => void> {
  const roomRef = doc(db, "rooms", ROOM_ID);
  const roomSnap = await getDoc(roomRef);
  const roomData = roomSnap.data();

  if (!roomData?.offer) throw new Error("No offer found");

  // The call may have been abandoned, or replaced by a newer one, while the
  // receiver was deciding whether to answer. Check before touching the peer
  // connection, so a dead call is never answered rather than answered wrongly.
  if (roomData.callId !== callId) {
    throw new Error("Panggilan sudah tidak aktif");
  }

  // Tangkap ICE candidates receiver
  const receiverCandidates = collection(roomRef, "receiverCandidates");
  pc.onicecandidate = (e) => {
    if (e.candidate)
      addDoc(receiverCandidates, { ...e.candidate.toJSON(), callId });
  };

  // Remote stream (video dari caller)
  pc.ontrack = (e) => {
    if (e.streams[0]) onRemoteStream(e.streams[0]);
  };

  // Set remote offer
  await pc.setRemoteDescription(new RTCSessionDescription(roomData.offer));

  // Buat answer
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  try {
    await setDoc(
      roomRef,
      {
        callId,
        answer: { type: answer.type, sdp: answer.sdp },
        status: "connected",
      },
      { merge: true }
    );
  } catch (err) {
    // The rules reject a second answer, and an answer to a call that has since
    // moved on. Both are ordinary races; neither deserves an error on screen.
    if (isPermissionDenied(err)) throw new Error("Panggilan sudah berakhir");
    throw err;
  }

  // Dengarkan ICE candidates dari caller
  const callerCandidates = collection(roomRef, "callerCandidates");
  const unsubCandidates = onSnapshot(callerCandidates, (snap) => {
    snap.docChanges().forEach((change) => {
      if (change.type === "added") {
        // Ignore candidates belonging to a call this connection never took part
        // in — a stale candidate is what breaks an otherwise good connection.
        if (change.doc.data().callId !== callId) return;
        pc.addIceCandidate(new RTCIceCandidate(change.doc.data()));
      }
    });
  });

  // Dengarkan jika caller hangup
  const unsubRoom = onSnapshot(roomRef, (snap) => {
    if (!snap.exists()) {
      pc.close();
      onRemoteHangup?.();
      return;
    }
    const data = snap.data();
    // Only the call this connection joined can end it. A newer call beginning
    // is not this call being hung up.
    if (data?.callId !== callId) return;
    if (data?.status === "ended") {
      pc.close();
      // Closing the peer connection only sets connectionState to "closed",
      // which the receiver would have to guess the meaning of. Say it plainly,
      // so the receiver can return to its idle state deliberately instead of
      // sitting in a half-torn-down call with the camera still held open.
      onRemoteHangup?.();
    }
  });

  return () => {
    unsubCandidates();
    unsubRoom();
  };
}

// ─── SHARED ──────────────────────────────────────────────────────────────────

export async function hangUp(): Promise<void> {
  const roomRef = doc(db, "rooms", ROOM_ID);
  const callId = activeCallId;
  activeCallId = null;

  // Mark the call ended, but only if it is still the one we are in — the rules
  // reject the write otherwise, which is exactly what should happen if the
  // receiver already moved on to a new call.
  if (callId) {
    await setDoc(
      roomRef,
      { callId, status: "ended", endedAt: Date.now() },
      { merge: true }
    );
  }

  await clearCandidates();
}

// Clearing the room document was the source of most of the flakiness: deleting
// it fires the receiver's watcher, which closes its peer connection, and the
// window before the next write was long enough for a real call to tear itself
// down in the middle. Nothing needs the document gone — the next call simply
// overwrites it, and a leftover "ended" document is inert because an incoming
// call is only ever reported for status "calling".
async function clearCandidates(): Promise<void> {
  const roomRef = doc(db, "rooms", ROOM_ID);

  const subcollections = ["callerCandidates", "receiverCandidates"];
  for (const sub of subcollections) {
    const colRef = collection(roomRef, sub);
    const snaps = await getDocs(colRef);
    await Promise.all(snaps.docs.map((d) => deleteDoc(d.ref)));
  }
}
