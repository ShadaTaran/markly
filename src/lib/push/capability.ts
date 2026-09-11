/**
 * Stage 37 §3/§4 — pure browser capability detection, no browser-sniffing:
 * every check is a real feature-presence test, never a user-agent string
 * match. `detectBrowserLabel` is the one exception, and deliberately not a
 * fingerprint (Stage 37 §11) — a short, coarse, purely cosmetic string
 * ("Chrome on Windows") used only as the subscription's optional display
 * label, never for any capability or security decision.
 */

export function detectPushCapability(): boolean {
  return typeof window !== "undefined" && typeof navigator !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export function detectBrowserLabel(): string {
  if (typeof navigator === "undefined" || !navigator.userAgent) return "This browser";
  const ua = navigator.userAgent;

  let browser = "Browser";
  if (/Edg\//.test(ua)) browser = "Edge";
  else if (/OPR\//.test(ua)) browser = "Opera";
  else if (/Firefox\//.test(ua)) browser = "Firefox";
  else if (/Chrome\//.test(ua) && !/Chromium/.test(ua)) browser = "Chrome";
  else if (/Safari\//.test(ua)) browser = "Safari";

  let os = "";
  if (/Windows/.test(ua)) os = "Windows";
  else if (/Mac OS X/.test(ua)) os = "Mac";
  else if (/Android/.test(ua)) os = "Android";
  else if (/iPhone|iPad|iPod/.test(ua)) os = "iOS";
  else if (/Linux/.test(ua)) os = "Linux";

  return os ? `${browser} on ${os}` : browser;
}
