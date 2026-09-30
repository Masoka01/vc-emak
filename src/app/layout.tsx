import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "VConnect",
  description: "Private video call app",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "VConnect",
  },
};

export const viewport: Viewport = {
  themeColor: "#0A1518",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="id">
      <head>
        <link rel="icon" href="/icons/favicon.ico" sizes="any" />
        <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="mobile-web-app-capable" content="yes" />
        {/*
          Heal: earlier builds shipped a next-pwa service worker that precached
          the whole JS bundle, so production could keep serving stale app code.
          The worker is gone, but an already-installed one still controls the
          page until it is explicitly unregistered — and it can only be reached
          from the network, which this script is. Safe and idempotent per load.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "if('serviceWorker' in navigator){navigator.serviceWorker.getRegistrations().then(function(rs){rs.forEach(function(r){r.unregister()})})}if(window.caches){caches.keys().then(function(ks){ks.forEach(function(k){caches.delete(k)})})}",
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
