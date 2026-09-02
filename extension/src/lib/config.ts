/**
 * The Markly deployment this extension talks to. Hardcoded to the local
 * dev server for Stage 18's controlled test — a real deployment would
 * make this configurable (and its host_permissions would need to match),
 * but that's out of scope while only test pages exist.
 */
export const MARKLY_BASE_URL = "http://localhost:3000";

import { hasOriginPermission } from "./site-permissions";

/**
 * Origins the content script is allowed to run on unconditionally —
 * matches manifest.json's required host_permissions exactly (just the
 * Markly dev/test origin). Every other origin is allowed only if the user
 * has explicitly granted it at runtime (see site-permissions.ts and
 * manifest.json's optional_host_permissions) — there is no separate
 * "sites I've enabled" preference that merely claims to track this;
 * Chrome's own granted-permission set is the only source of truth, so a
 * permission the user revokes (via the options page or chrome://
 * extensions) takes effect immediately without Markly needing to notice.
 *
 * This gate is deliberately separate from "does a specific adapter match
 * this URL": the service worker injects the content script on any page
 * within scope, and the content script itself then decides between an
 * adapter and universal detection (see content/content-script.ts) — so
 * universal detection can run on any user-enabled site without requiring
 * a dedicated adapter or any permission broader than that one origin.
 */
const REQUIRED_TRACKED_ORIGINS = [MARKLY_BASE_URL];

export async function isWithinTrackedScope(url: URL): Promise<boolean> {
  if (REQUIRED_TRACKED_ORIGINS.includes(url.origin)) return true;
  return hasOriginPermission(url);
}
