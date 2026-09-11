import "server-only";
import webpush from "web-push";
import type { NotificationPayload } from "@/lib/push/payload";

/**
 * Stage 37 §68 — the ONE module allowed to call the `web-push` package
 * (§19: a well-established server-side implementation, never hand-rolled
 * Web Push crypto). Every route/engine that needs to send a push goes
 * through sendWebPush() below — never `webpush.sendNotification()`
 * scattered across call sites.
 *
 * VAPID_PRIVATE_KEY is read only here, is never sent to the browser, and
 * is never logged (Stage 37 §17/§64) — `server-only` makes any accidental
 * import of this module from a Client Component a build error, matching
 * lib/supabase/admin.ts's own guard.
 */

export class PushNotConfiguredError extends Error {
  constructor() {
    super("Web Push is not configured for this deployment (missing VAPID environment variables).");
    this.name = "PushNotConfiguredError";
  }
}

interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

let cachedConfig: VapidConfig | null | undefined;

function readVapidConfig(): VapidConfig | null {
  if (cachedConfig !== undefined) return cachedConfig;

  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject) {
    cachedConfig = null;
    return null;
  }

  webpush.setVapidDetails(subject, publicKey, privateKey);
  cachedConfig = { publicKey, privateKey, subject };
  return cachedConfig;
}

/**
 * Stage 37 §89 — env validation. Never reveals WHICH of the three
 * variables is missing to any client-reachable surface; callers show a
 * single generic "not configured" state either way.
 */
export function isPushConfigured(): boolean {
  return readVapidConfig() !== null;
}

export interface PushSubscriptionKeys {
  endpoint: string;
  p256dh: string;
  authKey: string;
}

export interface SendResult {
  ok: boolean;
  /** null means a network-level failure with no HTTP response at all. */
  statusCode: number | null;
}

/**
 * Sends one Web Push message to one subscription. Never throws for an
 * ordinary delivery failure (dead endpoint, rate limit, provider outage)
 * — those come back as `{ ok: false, statusCode }` for the caller to
 * classify (see lib/push/delivery-policy.ts's classifyPushFailure). Only
 * a genuine configuration problem (missing VAPID env vars) throws, since
 * that is a deployment error, not a per-subscription outcome.
 */
export async function sendWebPush(subscription: PushSubscriptionKeys, payload: NotificationPayload): Promise<SendResult> {
  const config = readVapidConfig();
  if (!config) throw new PushNotConfiguredError();

  try {
    await webpush.sendNotification(
      { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.authKey } },
      JSON.stringify(payload),
    );
    return { ok: true, statusCode: 201 };
  } catch (err) {
    const statusCode =
      err && typeof err === "object" && "statusCode" in err && typeof (err as { statusCode?: unknown }).statusCode === "number"
        ? (err as { statusCode: number }).statusCode
        : null;
    return { ok: false, statusCode };
  }
}
