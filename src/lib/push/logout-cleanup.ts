import type { SupabaseClient } from "@supabase/supabase-js";
import { deletePushSubscriptionByEndpoint } from "@/lib/cloud/push-subscriptions";

/**
 * Stage 37 §15, hardened by the migration-review follow-up §8 — best-
 * effort: removes THIS browser's server-side push subscription row AND
 * invalidates the browser's own PushSubscription, before sign-out
 * completes, so a signed-out browser doesn't keep receiving this
 * account's reminders merely because a stale subscription remains either
 * server-side or in the browser itself. Browser-level Notification
 * *permission* is deliberately untouched — that's a per-origin OS/browser
 * setting, not a Markly account concern, and Markly cannot/should not
 * revoke it.
 *
 * The two cleanup steps are independent and both best-effort — a failure
 * in one must not skip the other: server-row deletion matters most for
 * privacy (stops delivery even if the browser-side unsubscribe somehow
 * fails), and the browser-side unsubscribe additionally means that even
 * an undeleted/failed-to-delete server row now points at a gone endpoint,
 * which the existing 404/410 dead-subscription pruning (Stage 37 §29/§30)
 * already handles on the next delivery attempt.
 *
 * Never blocks or fails sign-out: any error here (offline, no service
 * worker registered, no subscription, cloud not configured) is swallowed
 * so the user can always sign out regardless. This is a privacy backstop,
 * not the only one — see 0017_stage37_web_push.sql's own doc comment on
 * upsert_push_subscription for the second, structural safety net (an
 * endpoint re-subscribed under a different account atomically reassigns
 * ownership, so even a skipped/failed cleanup here can't leak a NEW
 * account's reminders to this browser).
 */
export async function bestEffortDisablePushOnLogout(supabase: SupabaseClient): Promise<void> {
  try {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const registration = await navigator.serviceWorker.getRegistration("/sw.js");
    const subscription = registration ? await registration.pushManager.getSubscription() : null;
    if (!subscription) return;
    await deletePushSubscriptionByEndpoint(supabase, subscription.endpoint).catch(() => undefined);
    await subscription.unsubscribe().catch(() => undefined);
  } catch {
    // Best-effort only.
  }
}
