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

// ─── CALLER (ADMIN) ──────────────────────────────────────────────────────────

export async function startCall(
  pc: RTCPeerConnection,
  onRemoteStream: (stream: MediaStream) => void
): Promise<() => void> {
  const roomRef = doc(db, "rooms", ROOM_ID);

  // Bersihkan room lama
  await clearRoom();

  // Tangkap ICE candidates caller
  const callerCandidates = collection(roomRef, "callerCandidates");
  pc.onicecandidate = (e) => {
    if (e.candidate) addDoc(callerCandidates, e.candidate.toJSON());
  };

  // Remote stream
  pc.ontrack = (e) => {
    if (e.streams[0]) onRemoteStream(e.streams[0]);
  };

  // Buat offer
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  await setDoc(roomRef, {
    offer: { type: offer.type, sdp: offer.sdp },
    status: "calling",
    createdAt: Date.now(),
  });

  // Dengarkan answer dari receiver
  const unsubRoom = onSnapshot(roomRef, async (snap) => {
    const data = snap.data();
    if (data?.answer && !pc.currentRemoteDescription) {
      await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
    }
  });

  // Dengarkan ICE candidates dari receiver
  const receiverCandidates = collection(roomRef, "receiverCandidates");
  const unsubCandidates = onSnapshot(receiverCandidates, (snap) => {
    snap.docChanges().forEach((change) => {
      if (change.type === "added") {
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
  onIncomingCall: () => void
): () => void {
  const roomRef = doc(db, "rooms", ROOM_ID);
  return onSnapshot(roomRef, (snap) => {
    const data = snap.data();
    if (data?.status === "calling" && data?.offer) {
      onIncomingCall();
    }
  });
}

export async function answerCall(
  pc: RTCPeerConnection,
  onRemoteStream: (stream: MediaStream) => void
): Promise<() => void> {
  const roomRef = doc(db, "rooms", ROOM_ID);
  const roomSnap = await getDoc(roomRef);
  const roomData = roomSnap.data();

  if (!roomData?.offer) throw new Error("No offer found");

  // Tangkap ICE candidates receiver
  const receiverCandidates = collection(roomRef, "receiverCandidates");
  pc.onicecandidate = (e) => {
    if (e.candidate) addDoc(receiverCandidates, e.candidate.toJSON());
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

  await setDoc(
    roomRef,
    { answer: { type: answer.type, sdp: answer.sdp }, status: "connected" },
    { merge: true }
  );

  // Dengarkan ICE candidates dari caller
  const callerCandidates = collection(roomRef, "callerCandidates");
  const unsubCandidates = onSnapshot(callerCandidates, (snap) => {
    snap.docChanges().forEach((change) => {
      if (change.type === "added") {
        pc.addIceCandidate(new RTCIceCandidate(change.doc.data()));
      }
    });
  });

  // Dengarkan jika caller hangup
  const unsubRoom = onSnapshot(roomRef, (snap) => {
    if (!snap.exists() || snap.data()?.status === "ended") {
      pc.close();
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
  await setDoc(roomRef, { status: "ended" }, { merge: true });
  await clearRoom();
}

async function clearRoom(): Promise<void> {
  const roomRef = doc(db, "rooms", ROOM_ID);

  const subcollections = ["callerCandidates", "receiverCandidates"];
  for (const sub of subcollections) {
    const colRef = collection(roomRef, sub);
    const snaps = await getDocs(colRef);
    await Promise.all(snaps.docs.map((d) => deleteDoc(d.ref)));
  }

  await deleteDoc(roomRef);
}
