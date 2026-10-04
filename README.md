# VConnect — Private Video Call PWA

Aplikasi video call dua arah berbasis **Next.js + TypeScript + Firebase + WebRTC**.  
Bisa di-install sebagai aplikasi native (PWA) di HP maupun desktop.

---

## Arsitektur

```
/              → Halaman Receiver (tunggu panggilan, auto-answer)
/admin         → Halaman Caller/Admin (pilih receiver → call)

WebRTC Signaling via Firestore, satu room per receiver (di alamat Auth uid):
  rooms/{receiverUid}
    ├── offer / answer (SDP)
    ├── status: "calling" | "connected" | "ended"
    ├── callerCandidates/  (ICE candidates dari admin)
    └── receiverCandidates/ (ICE candidates dari receiver)
```

Receiver mendaftar sendiri dari aplikasinya (email + kata sandi) lalu menunggu
disetujui admin. Hanya receiver yang `approved` yang bisa dihubungi — aturannya
ditegakkan di `firestore.rules`, bukan di client.

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
```

Tidak ada lagi variabel room atau PIN. Setiap receiver signaling di room-nya
sendiri (`rooms/<uid Auth-nya>`), jadi tidak ada id bersama yang perlu
disamakan antara env dan rules.

Dua hal yang paling sering jadi sumber masalah:

- **Receiver baru belum disetujui.** Pendaftaran menulis profil dengan
  `approved: false`, dan rules menolak panggilan ke receiver yang belum
  disetujui. Kalau admin tidak bisa menghubungi receiver yang terlihat online,
  cek dulu field `approved` di dokumen `users/<uid>`-nya.
- **Admin tidak dikenali.** Yang dianggap admin hanyalah uid yang punya dokumen
  di koleksi `admins`. Koleksi itu tidak bisa ditulis dari client, jadi buat
  isinya sekali dengan kredensial admin (Firebase Console atau
  `firebase firestore:set`). Tanpa itu, semua tulis signaling ditolak
  `PERMISSION_DENIED`.

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
Receiver daftar dari / → profil users/{uid} terbit dengan approved: false
Admin menyetujui receiver → approved: true
Admin buka /admin → pilih receiver → tekan "Mulai Panggilan"
    ↓ Firestore: tulis offer + callerCandidates ke rooms/{receiverUid}
Receiver buka / → onSnapshot di rooms/{uid-nya sendiri} detect "calling"
    ↓ Auto answer → tulis answer + receiverCandidates
Admin & Receiver exchange ICE candidates via Firestore
    ↓ WebRTC peer-to-peer connection established
Video call berlangsung langsung P2P (tidak lewat server)
```

---

## Catatan Keamanan

- **Identitas dari Firebase Auth, ditegakkan di rules.** Receiver hanya bisa
  membaca/menjawab room-nya sendiri; admin membaca semua room dan satu-satunya
  yang boleh memulai panggilan — itu pun hanya ke receiver yang ada dan
  `approved`. Room id yang bocor tidak lagi berguna bagi orang asing: tanpa
  sesi yang cocok, rules menolak tulisnya.
- Pendaftaran menulis profil sendiri dengan `approved: false`, dan rules
  mengunci field itu supaya receiver tidak bisa menyetujui dirinya sendiri —
  persetujuan mutlak pekerjaan admin.
- Koleksi `admins` tidak punya jalur tulis dari client; hanya bisa diisi
  dengan kredensial admin, jadi tidak ada yang bisa mengangkat dirinya sendiri
  jadi admin.
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

Catatan yang perlu diketahui sebelum mengubah kode di sini.

### Styling: Tailwind v4, bukan CSS Modules

Sudah migrasi dari CSS Modules ke **Tailwind v4**. `admin.module.css` dan
`receiver.module.css` sudah dihapus; gaya sekarang inline sebagai utility class
di dalam `page.tsx`.

- Setup: `postcss.config.mjs` + satu baris `@import "tailwindcss";` di
  `src/app/globals.css`. Tailwind v4 tidak butuh `tailwind.config.js`.
- Token desain ada di blok `@theme` dan menghasilkan utility seperti
  `bg-surface`, `text-ink-dim`, `border-line`, `rounded-lg`, `shadow-md`.
- Nama token diubah saat migrasi supaya utilinya enak dibaca: yang dulunya
  `--color-text` dan `--color-border` kini bernama `--color-ink` dan
  `--color-line`. **Nilai warnanya tidak berubah.**

Tidak ada `autoprefixer` di config PostCSS. Tailwind v4 sudah menangani vendor
prefix sendiri; mendaftarkan plugin yang tidak terpasang akan menggagalkan build.

### Aturan yang tidak boleh dilanggar

- **Jangan tambah animasi `infinite` di halaman receiver (`/`).** Ripple yang
  looping dihapus karena baterai habis saat HP ditinggal menunggu panggilan.
  Penanda status sengaja dibuat statik, dengan jam "terakhir diperiksa" sebagai
  penggantinya. Spinner saat menyambungkan tetap dipakai karena hanya hidup
  sekitar 2 detik. Kalau memang butuh animasi, pastikan sifatnya finite atau
  hanya muncul saat ada aksi pengguna.
- **Jangan akses `process.env` secara dinamis di kode client.** Next.js hanya
  meng-inline `process.env.NEXT_PUBLIC_*` kalau ditulis sebagai akses properti
  literal. `process.env[key]` lolos ke runtime browser, tempat `process.env`
  kosong, dan selalu menghasilkan `undefined` — ini sempat membuat admin
  terkunci di layar "Belum Dikonfigurasi" padahal env-nya sudah lengkap. Baca
  lewat `src/lib/env.ts`, yang sudah mengekspor nilainya secara langsung.

### Sisa pekerjaan

- **Belum ada test suite.** Semua verifikasi selama ini manual lewat browser.
- **Rules Firestore belum di-deploy** di environment ini. Jalankan
  `npm run deploy:rules`; sampai itu, signalling tetap `PERMISSION_DENIED`.
- **Ikon PWA masih 404.** `public/icons/icon-192.png` dan sejenisnya belum
  ada, jadi request dari service worker gagal. Tidak mengganggu halaman, tapi
  berarti PWA belum benar-benar terpasang.

