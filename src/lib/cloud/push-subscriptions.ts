import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Stage 37 — client-callable wrappers around push_subscriptions, matching
 * lib/cloud/recovery.ts's own established convention (direct-to-Supabase
 * via the session client + RPC, not a bespoke Next.js route) for anything
 * that only needs RLS/ownership, not a server secret. The one operation
 * that genuinely needs a server secret (sending a push, which needs the
 * VAPID private key) is the ONLY push-related Next.js route — see
 * app/api/push/test/route.ts and app/api/push/process-due/route.ts.
 *
 * Every function here operates on the CURRENT session's own rows only —
 * see supabase/migrations/0017_stage37_web_push.sql for the RLS policies
 * (select/delete own; insert/update is RPC-only, see
 * upsertPushSubscription's own doc comment) that make this true
 * regardless of what a caller passes in.
 */

export interface SubscribeInput {
  endpoint: string;
  p256dh: string;
  authKey: string;
  /** Optional coarse, non-fingerprinting label — see usePushNotifications.ts for exactly what it derives from. */
  label?: string;
}

export type SubscribeStatus = "ok" | "invalid" | "unauthorized";

function parseSubscribeResult(data: unknown): { status: SubscribeStatus; id?: string } | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  const status = record.status;
  if (status !== "ok" && status !== "invalid" && status !== "unauthorized") return null;
  return { status, id: typeof record.id === "string" ? record.id : undefined };
}

/**
 * Calls upsert_push_subscription (SECURITY DEFINER) — the only path that
 * may create or reassign a push_subscriptions row. Re-subscribing the same
 * browser (same endpoint) under a different Markly account atomically
 * reassigns that row's ownership to whoever is currently authenticated;
 * see the migration's own doc comment for the full rule and its privacy
 * rationale (Stage 37 §14/§16).
 */
export async function upsertPushSubscription(supabase: SupabaseClient, input: SubscribeInput): Promise<{ status: SubscribeStatus; id?: string }> {
  const { data, error } = await supabase.rpc("upsert_push_subscription", {
    p_endpoint: input.endpoint,
    p_p256dh: input.p256dh,
    p_auth_key: input.authKey,
    p_label: input.label ?? null,
  });
  if (error) throw error;
  const result = parseSubscribeResult(data);
  if (!result) throw new Error("upsert_push_subscription returned an unexpected shape");
  return result;
}

/** Stage 37 §21 — disables notifications on THIS browser only; every other device's row is untouched (a plain delete scoped by this browser's own endpoint value, never "all my devices"). */
export async function deletePushSubscriptionByEndpoint(supabase: SupabaseClient, endpoint: string): Promise<void> {
  const { error } = await supabase.from("push_subscriptions").delete().eq("endpoint", endpoint);
  if (error) throw error;
}

export interface OwnSubscriptionStatus {
  registered: boolean;
  disabled: boolean;
}

/**
 * Stage 37 §47/§48 — "is THIS browser's existing subscription known to
 * the server, under MY current session." RLS already scopes this to rows
 * the caller owns, so a row that exists but belongs to a different
 * account (e.g. this browser was last subscribed by someone else) simply
 * doesn't come back — collapsing correctly to `registered: false` for the
 * current session without ever revealing that a different owner exists.
 */
export async function getOwnSubscriptionStatus(supabase: SupabaseClient, endpoint: string): Promise<OwnSubscriptionStatus> {
  const { data, error } = await supabase.from("push_subscriptions").select("disabled_at").eq("endpoint", endpoint).maybeSingle();
  if (error) throw error;
  if (!data) return { registered: false, disabled: false };
  return { registered: true, disabled: data.disabled_at !== null };
}
