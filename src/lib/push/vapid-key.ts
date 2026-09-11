/**
 * Stage 37 §43 — converts a URL-safe base64 VAPID public key string into
 * the Uint8Array PushManager.subscribe's applicationServerKey expects.
 * The one well-known small conversion every Web Push client needs; never
 * hand-rolled cryptography (that's `web-push`'s job server-side — see
 * lib/push/transport.ts). Pure and deterministic — see
 * scripts/verify-web-push.mjs for a reproduced-verbatim round-trip test.
 */
export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}
