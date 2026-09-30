/**
 * Accessor env yang aman dipakai di client.
 *
 * PENTING: jangan pernah menyentuh `process.env.ADMIN_PIN` di file ini.
 * Next.js hanya meng-inline prefix `NEXT_PUBLIC_` ke bundle client; variabel
 * lain jadi `undefined` di browser, sehingga pengecekan di sini akan selalu
 * "tidak terpasang" dan membuat halaman admin salah menampilkan layar
 * "belum dikonfigurasi". Pengecekan ADMIN_PIN hanya boleh di server
 * (src/app/api/verify-pin/route.ts).
 */

const FIREBASE_KEYS = [
  "NEXT_PUBLIC_FIREBASE_API_KEY",
  "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
  "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
  "NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET",
  "NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID",
  "NEXT_PUBLIC_FIREBASE_APP_ID",
] as const;

const DEFAULTS: Record<(typeof FIREBASE_KEYS)[number], string> = {
  NEXT_PUBLIC_FIREBASE_API_KEY: "",
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: "",
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: "",
  NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: "",
  NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: "",
  NEXT_PUBLIC_FIREBASE_APP_ID: "",
};

/** Nilai env Firebase, dengan fallback string kosong supaya tidak ada `undefined`. */
export const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY || DEFAULTS.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN || DEFAULTS.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || DEFAULTS.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || DEFAULTS.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId:
    process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID || DEFAULTS.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID || DEFAULTS.NEXT_PUBLIC_FIREBASE_APP_ID,
} as const;

/** Nama variabel Firebase yang masih kosong di env. */
export function missingFirebaseVars(): string[] {
  return FIREBASE_KEYS.filter((key) => !process.env[key]);
}

/** True hanya kalau keenam variabel Firebase terisi. */
export function isFirebaseConfigured(): boolean {
  return missingFirebaseVars().length === 0;
}

/** ID room signaling. Default dikosongkan agar tidak ada room publik yang bocor. */
export function getRoomId(): string {
  return process.env.NEXT_PUBLIC_ROOM_ID || "";
}
