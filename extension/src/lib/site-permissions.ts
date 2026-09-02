/**
 * Thin wrapper around chrome.permissions for per-origin, runtime-granted
 * tracking access. This is the ONLY mechanism used to decide whether the
 * extension may run on a third-party site — never a stored preference
 * that merely claims to reflect Chrome's actual grant (see manifest.json:
 * optional_host_permissions declares a wildcard scheme-and-host pattern
 * covering any origin, so a single specific origin can be requested at
 * runtime, but nothing is ever requested without an explicit user click,
 * and nothing beyond the Markly dev origin is granted by default).
 */

/** The exact origin-scoped match pattern chrome.permissions deals in for a given URL. */
export function originPatternFor(url: URL): string {
  return `${url.origin}/*`;
}

export async function hasOriginPermission(url: URL): Promise<boolean> {
  return chrome.permissions.contains({ origins: [originPatternFor(url)] });
}

/** Must be called from within a user gesture (e.g. a popup button's click handler) — Chrome silently rejects host permission requests otherwise. */
export async function requestOriginPermission(url: URL): Promise<boolean> {
  return chrome.permissions.request({ origins: [originPatternFor(url)] });
}

export async function revokeOriginPermission(originPattern: string): Promise<boolean> {
  return chrome.permissions.remove({ origins: [originPattern] });
}

/** Every currently-granted host permission origin pattern — used only by the options page's "Enabled Sites" list. */
export async function listGrantedOriginPatterns(): Promise<string[]> {
  const granted = await chrome.permissions.getAll();
  return granted.origins ?? [];
}
