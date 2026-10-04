import { initializeApp, getApps } from "firebase/app";
import { getAuth } from "firebase/auth";
import type { Auth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { firebaseConfig, isFirebaseConfigured } from "./env";

// firebaseConfig always has concrete values (falling back to empty strings), so
// initializeApp never receives undefined here. An incomplete setup is detected
// via isFirebaseConfigured() from ./env, which lets the UI show clear guidance
// instead of crashing.
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
export const db = getFirestore(app);

// getAuth THROWS on an incomplete config ("auth/invalid-api-key"), and this
// module is reached through webrtc.ts, which every page imports. Creating the
// instance eagerly would replace the friendly "Firebase not configured" screen
// with a blank crash, so it stays null until the config is actually complete and
// every caller in ./auth checks before using it.
export const auth: Auth | null = isFirebaseConfigured() ? getAuth(app) : null;
