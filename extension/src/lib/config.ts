/**
 * The Markly deployment this extension talks to. Hardcoded to the local
 * dev server for Stage 18's controlled test — a real deployment would
 * make this configurable (and its host_permissions would need to match),
 * but that's out of scope while only test pages exist.
 */
export const MARKLY_BASE_URL = "http://localhost:3000";

/**
 * Origins the content script is allowed to run on at all — currently just
 * the Markly dev origin itself, matching manifest.json's host_permissions
 * exactly. This gate is deliberately separate from "does a specific
 * adapter match this URL": the service worker injects the content script
 * on any page within this (already narrow) scope, and the content script
 * itself then decides between an adapter and universal detection (see
 * content/content-script.ts) — so universal detection can run on pages
 * with no dedicated adapter without requiring any broader permission.
 * Real Stage 19 site origins get added here (and to
 * host_permissions/optional_host_permissions) alongside their adapter,
 * never broadened speculatively ahead of time.
 */
const TRACKED_ORIGINS = [MARKLY_BASE_URL];

export function isWithinTrackedScope(url: URL): boolean {
  return TRACKED_ORIGINS.includes(url.origin);
}
