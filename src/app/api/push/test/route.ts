import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { sendWebPush, isPushConfigured, type PushSubscriptionKeys } from "@/lib/push/transport";
import { buildTestNotificationPayload } from "@/lib/push/payload";
import { classifyPushFailure, shouldDisableSubscription } from "@/lib/push/delivery-policy";
import type { PushSubscriptionRow } from "@/lib/supabase/database.types";

const MAX_ENDPOINT_LENGTH = 2000;

interface TestRequestBody {
  endpoint?: unknown;
}

/**
 * Stage 37 §22/§94 — sends exactly one test push, to exactly the
 * requesting browser's own subscription, never every device on the
 * account. Session-authenticated (never a device token or cron secret —
 * this is an ordinary logged-in user action). Never mutates any reminder;
 * the resulting reminder_deliveries row is `kind: "test"`, structurally
 * distinguishable from a real reminder delivery (Stage 37 §22/§65/§92).
 */
export async function POST(request: Request) {
  if (!isPushConfigured()) return NextResponse.json({ error: "not_configured" }, { status: 503 });

  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });

  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  let body: TestRequestBody;
  try {
    body = (await request.json()) as TestRequestBody;
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
  if (!endpoint || endpoint.length > MAX_ENDPOINT_LENGTH) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  // Stage 37 §20/§62 — ownership comes from the session, not the request
  // body: this SELECT runs under the normal session client, RLS-scoped to
  // `auth.uid() = user_id`, so no other user's subscription can ever be
  // matched here regardless of what endpoint value is supplied.
  const { data: subscriptionRow, error: lookupError } = await supabase
    .from("push_subscriptions")
    .select("*")
    .eq("endpoint", endpoint)
    .eq("user_id", userData.user.id)
    .is("disabled_at", null)
    .maybeSingle();
  if (lookupError) return NextResponse.json({ error: "failed" }, { status: 502 });
  if (!subscriptionRow) return NextResponse.json({ error: "not_subscribed" }, { status: 404 });

  const subscription = subscriptionRow as PushSubscriptionRow;
  const keys: PushSubscriptionKeys = { endpoint: subscription.endpoint, p256dh: subscription.p256dh, authKey: subscription.auth_key };
  const payload = buildTestNotificationPayload();

  const result = await sendWebPush(keys, payload);

  // Stage 37 §64 — the admin client is used only for the two writes RLS
  // deliberately doesn't allow a plain session client to make (see
  // 0017_stage37_web_push.sql's RLS comments); never to re-read or expose
  // anything beyond what this request already legitimately owns.
  const admin = getSupabaseAdminClient();
  if (admin) {
    const now = new Date().toISOString();
    if (result.ok) {
      await admin.from("push_subscriptions").update({ last_used_at: now }).eq("id", subscription.id);
    } else {
      const failureClass = classifyPushFailure(result.statusCode);
      if (shouldDisableSubscription(failureClass)) {
        await admin.from("push_subscriptions").update({ disabled_at: now }).eq("id", subscription.id);
      }
    }
    await admin.from("reminder_deliveries").insert({
      user_id: userData.user.id,
      kind: "test",
      status: result.ok ? "sent" : "failed",
      retryable: false,
      results: [{ subscriptionId: subscription.id, outcome: result.ok ? "sent" : "retryable_failure", statusCode: result.statusCode }],
      completed_at: now,
    });
  }

  if (!result.ok) return NextResponse.json({ error: "send_failed" }, { status: 502 });
  return NextResponse.json({ status: "sent" });
}
