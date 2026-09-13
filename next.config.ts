import type { NextConfig } from "next";

/**
 * Stage 44 — public-beta hardening. Deliberately NOT a Content-Security-
 * Policy: Markly loads from enough distinct external origins (Supabase
 * auth/storage/API, AniList's API and OAuth redirect, TMDB/RAWG images and
 * their own API hosts, user-supplied cover-image URLs of arbitrary origin,
 * Web Push's browser-vendor endpoints, the browser extension's own
 * messaging) that a CSP written without deliberately enumerating and
 * testing every one of them risks silently breaking a real feature in
 * production — see the Stage 44 report's own "SECURITY HEADER APPROVAL
 * REQUIRED" section for the deferred CSP proposal. Every header below is
 * independently safe: none restricts any origin Markly actually talks to,
 * and none touches Notification permission (Web Push) or any capability
 * this app uses.
 */
const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
