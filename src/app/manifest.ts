import type { MetadataRoute } from "next";

/**
 * Stage 38 — Markly's Web App Manifest.
 *
 * `id`: a relative "/" so the manifest stays portable across preview/local
 * environments (Stage 38 §34) without hardcoding the production origin in
 * source. Per the Web App Manifest spec the browser still resolves this to
 * an absolute, origin-qualified URL for the actual installed-app identity —
 * there is no manifest configuration that makes the identity host-
 * independent. A future production domain change would therefore still be
 * treated as a distinct installed app by browsers; that is a platform
 * constraint, not something fixable here (Stage 38 §3).
 *
 * `background_color`: matches the light theme's own background
 * (`--background` in globals.css). The document's SSR default is
 * `data-theme="light"` (corrected to the stored/OS preference by an inline
 * script immediately after), so this is the color most first paints will
 * actually briefly show.
 *
 * `theme_color`: the brand accent (`--accent` in light mode / the fill
 * color of icon.svg itself) — a single static value, since the manifest
 * spec has no per-theme mechanism. `src/app/layout.tsx`'s `viewport` export
 * carries a light/dark pair for the actual in-browser `theme-color` meta
 * tag; this manifest field only affects OS-level install surfaces (e.g. the
 * Android splash screen), which use the light value.
 *
 * No `orientation` lock — nothing about Markly requires one. No
 * `shortcuts` — "Add Item" is a client-side dialog action with no stable
 * URL to target (see the Command Palette's "action"-kind entry for it), and
 * a shortcut can only point at Library/Reminders, which didn't seem worth
 * the added surface for this pass (Stage 38 §28). No `prefer_related_
 * applications` field — its absence already satisfies the installability
 * requirement that it be absent or false.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Markly",
    short_name: "Markly",
    description: "Your universal personal library. Never lose your place again.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#fafafa",
    theme_color: "#3b82f6",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
