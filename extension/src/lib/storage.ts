/**
 * The device token lives only in chrome.storage.local, never webpage
 * localStorage — and only trusted extension contexts (this module is
 * imported only by the service worker and popup, never the content
 * script) ever read it. The service worker additionally restricts
 * chrome.storage.local itself to TRUSTED_CONTEXTS on startup (see
 * background/service-worker.ts), so even a compromised/malicious page
 * script cannot read it via chrome.storage APIs either.
 */
const TOKEN_KEY = "markly_device_token";

export async function getDeviceToken(): Promise<string | null> {
  const result = await chrome.storage.local.get(TOKEN_KEY);
  const value = result[TOKEN_KEY];
  return typeof value === "string" ? value : null;
}

export async function setDeviceToken(token: string): Promise<void> {
  await chrome.storage.local.set({ [TOKEN_KEY]: token });
}

export async function clearDeviceToken(): Promise<void> {
  await chrome.storage.local.remove(TOKEN_KEY);
}
