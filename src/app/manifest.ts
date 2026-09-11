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
 *
 * Stage 39 — `share_target` deliberately uses GET, not POST: Markly only
 * ever receives a small url/title/text payload (never files), GET needs no
 * multipart/redirect-lifecycle handling, survives a refresh safely, and is
 * trivially testable as a plain deep link. `action` points at `/share`,
 * same-origin, and `params` map 1:1 onto exactly the fields `/share` already
 * reads from its query string — no `files` entry (Stage 39 explicitly does
 * not accept shared files).
 *
 * Privacy tradeoff of GET (Stage 39 correction — stated precisely, not
 * overclaimed): the shared title/text/url travel as query parameters, so
 * they (a) appear in this browser's own history/address-bar state for this
 * one navigation, and (b) are necessarily present in the request URL that
 * passes through the hosting infrastructure on its way to this route.
 * Markly's own application code does not explicitly log, persist, or send
 * that raw query string anywhere before the user explicitly saves (see
 * ShareCaptureView's own doc comment) — but hosting/platform-level request
 * logging is outside this codebase's control and may observe request URLs
 * according to the provider's own behavior/configuration. This is an
 * accurate description of a real, accepted tradeoff, not a privacy
 * guarantee this file can make on the hosting layer's behalf. Switching to
 * POST purely to avoid this was considered and rejected for this pass —
 * see PART B of the Stage 39 correction report for the full reasoning.
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
    share_target: {
      action: "/share",
      method: "GET",
      params: {
        title: "title",
        text: "text",
        url: "url",
      },
    },
  };
}
