# VConnect — Private Video Call PWA

Aplikasi video call dua arah berbasis **Next.js + TypeScript + Firebase + WebRTC**.  
Bisa di-install sebagai aplikasi native (PWA) di HP maupun desktop.

---

## Arsitektur

```
/              → Halaman Receiver (tunggu panggilan, auto-answer)
/admin         → Halaman Caller/Admin (PIN → call)

WebRTC Signaling via Firestore:
  rooms/{ROOM_ID}
    ├── offer / answer (SDP)
    ├── status: "calling" | "connected" | "ended"
    ├── callerCandidates/  (ICE candidates dari admin)
    └── receiverCandidates/ (ICE candidates dari receiver)
```

---

## Setup

### 1. Clone & Install

```bash
npm install
```

### 2. Firebase Project

1. Buka [Firebase Console](https://console.firebase.google.com)
2. Buat project baru
3. **Firestore Database** → Create database → Start in test mode
4. **Project Settings** → Your Apps → Add Web App → copy config
5. Deploy Firestore rules:
   ```bash
   npm install -g firebase-tools
   firebase login
   firebase init firestore   # pilih project lo
   npm run deploy:rules
   ```

   > **Penting:** sampai rules-nya di-deploy, project masih memakai default-deny
   > dan **semua** request signaling akan ditolak `PERMISSION_DENIED`. Kalau lebih
   > nyaman, salin isi `firestore.rules` ke Firebase Console → **Firestore Database
   > → Rules** → Publish.

### 3. Environment Variables

```bash
cp .env.example .env.local
```
Isi `.env.local`:

```env
NEXT_PUBLIC_FIREBASE_API_KEY=...
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=...
NEXT_PUBLIC_FIREBASE_PROJECT_ID=...
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=...
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=...
NEXT_PUBLIC_FIREBASE_APP_ID=...

ADMIN_PIN=pinrahasiakamu123
NEXT_PUBLIC_ROOM_ID=vc-xxxxxxxxxxxxxxxxxxxx
```

Dua hal yang paling sering jadi sumber masalah:

- **`ADMIN_PIN` wajib ada.** Kalau kosong, `/api/verify-pin` membalas HTTP 500
  `server_misconfigured` dan halaman login admin **selalu gagal** — bukan karena
  PIN salah, tapi karena tidak ada PIN untuk dicocokkan. Kalau kamu lihat
  "PIN salah" padahal tidak pernah salah ketik, cek variabel ini dulu.
- **`NEXT_PUBLIC_ROOM_ID` harus sama persis** dengan room id yang di-hardcode di
  `firestore.rules`. Firestore rules tidak bisa membaca env, jadi kalau keduanya
  berbeda, semua request signaling ditolak `PERMISSION_DENIED`.

### 4. Icons PWA

Taruh icon app di `/public/icons/`:
- `icon-192.png` (192×192 px)
- `icon-512.png` (512×512 px)

Bisa generate otomatis di: https://realfavicongenerator.net

### 5. Run Dev

```bash
npm run dev
```

- Receiver: http://localhost:3000
- Admin: http://localhost:3000/admin

### 6. Deploy ke Vercel (Recommended)

```bash
# Push ke GitHub dulu, lalu connect di vercel.com
# Set environment variables di Vercel Dashboard
npx vercel --prod
```

**Pastikan HTTPS** — WebRTC dan camera access butuh HTTPS. Vercel otomatis HTTPS ✅

---

## Install sebagai Aplikasi (PWA)

### Android (Chrome)
1. Buka URL di Chrome
2. Tap menu (⋮) → "Add to Home Screen" / "Install App"
3. Pilih "Install" → App muncul di home screen

### iOS (Safari)
1. Buka URL di Safari
2. Tap Share (□↑) → "Add to Home Screen"
3. Tap "Add"

### Desktop (Chrome/Edge)
1. Lihat ikon install di address bar
2. Klik → "Install"

---

## Alur Kerja

```
Admin buka /admin → input PIN → tekan "Mulai Panggilan"
    ↓ Firestore: tulis offer + callerCandidates
Receiver buka / → onSnapshot detect "calling"
    ↓ Auto answer → tulis answer + receiverCandidates
Admin & Receiver exchange ICE candidates via Firestore
    ↓ WebRTC peer-to-peer connection established
Video call berlangsung langsung P2P (tidak lewat server)
```

---

## Catatan Keamanan

- **Tidak ada autentikasi di Firestore.** Rules-nya `allow read, write: if true`
  untuk satu room tertentu. Yang melindungi aplikasi ini adalah room id yang
  sulit ditebak — bukan login. Kalau room id bocor (URL yang dibagikan, screenshot,
  log), siapa pun bisa menulis offer/answer palsu ke room itu dan menyamar
  sebagai caller atau receiver.
- Room id di-hardcode di `firestore.rules` **dan** ada di `NEXT_PUBLIC_ROOM_ID`.
  Mengganti room id berarti mengubah keduanya lalu deploy ulang rules.
- PIN disimpan di server (env `ADMIN_PIN`), tidak pernah dikirim ke client secara
  plain, dan dibandingkan dengan `timingSafeEqual`. Endpoint-nya dibatasi 5x gagal
  per 15 menit per IP — perlu diingat ini masih in-memory, jadi hilang saat
  server cold start dan tidak dibagi antar instance.
- Untuk proteksi yang lebih kuat, langkah berikutnya adalah Firebase Auth dengan
  rules berbasis user. Perlu diperhitungkan: receiver harus login dulu sebelum
  auto-answer bisa jalan.
- WebRTC video/audio stream: **end-to-end, tidak lewat Firebase**.

---

## Tech Stack

| Layer | Tech |
|-------|------|
| Framework | Next.js 14 (App Router) |
| Language | TypeScript |
| Signaling | Firebase Firestore |
| Video | WebRTC (native browser API) |
| PWA | next-pwa (Workbox) |
| Deploy | Vercel / Firebase Hosting |

---

## Utang Teknik

Catatan yang sengaja belum dikerjakan, biar tidak hilang.

### Migrasi ke Tailwind

Styling sekarang masih **CSS Modules + custom properties**, bukan Tailwind.
Tidak ada `tailwindcss` di `package.json`, tidak ada `tailwind.config.js`, dan
seluruh gaya ada di tiga file:

- `src/app/globals.css` — token desain (`--accent`, `--surface`, `--shadow-*`, dll)
- `src/app/admin/admin.module.css`
- `src/app/receiver.module.css`

Kalau nanti mau pindah ke Tailwind, urutannya:

1. `npm i -D tailwindcss @tailwindcss/postcss` — Tailwind v4 tidak butuh
   `tailwind.config.js` maupun `postcss.config.js` terpisah, cukup satu import
   di `globals.css`.
2. Pindahkan token `--*` ke blok `@theme`.
3. Rewrite dua file CSS module di atas menjadi utility class di dalam JSX.

Yang perlu diwaspadai: layout video memakai positioning presisi
(`position: fixed; inset: 0` untuk layer video, dan picture-in-picture lokal di
`bottom`/`right` tetap). Ini bisa ditulis ulang dengan utility class, tapi
**bukan** find-replace — perhitungannya kira-kira satu sesi kerja.

Sebaiknya migrasi dilakukan sekarang, sebelum halaman video makin banyak
kondisi, bukan sesudahnya. Kalau migrasi ditunda, tidak ada yang perlu dibongkar
— CSS Modules dan Tailwind bisa hidup berdampingan.

Catatan: migrasi ke Tailwind sendiri **tidak akan membuat tampilan lebih bagus**.
Itu soal hierarki dan proporsi, bukan tooling.
