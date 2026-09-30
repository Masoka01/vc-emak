import { initializeApp, getApps } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { firebaseConfig } from "./env";

// firebaseConfig always has concrete values (falling back to empty strings), so
// initializeApp never receives undefined here. An incomplete setup is detected
// via isFirebaseConfigured() from ./env, which lets the UI show clear guidance
// instead of crashing.
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
export const db = getFirestore(app);
