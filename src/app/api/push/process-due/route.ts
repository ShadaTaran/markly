import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { isPushConfigured } from "@/lib/push/transport";
import { processDueReminders } from "@/lib/push/deliver";

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Stage 37 §37/§38/§39 — the scheduled due-reminder processor. Deliberately
 * NOT session-authenticated: it must act across every user's reminders in
 * one invocation, which no single user's session could ever legitimately
 * authorize (Stage 37 §38's explicit rule — "do not accept user auth as
 * permission to process all users' reminders"). Protected instead by a
 * server-only bearer secret (PUSH_CRON_SECRET) that an external scheduler
 * supplies — never a NEXT_PUBLIC_ variable, never logged, never accepted
 * via query string.
 *
 * No scheduling infrastructure calls this route in this stage (Stage 37's
 * Phase 0 confirmed no Vercel Cron / Supabase Edge Function / pg_cron
 * exists in this repository) — see the Stage 37 report's SCHEDULER READY
 * status. Its existence and correctness are independent of whether
 * anything is actually configured to call it yet; a manually authorized
 * request (e.g. from an operator's own terminal, never from this app's own
 * UI) is the only way it runs today.
 */
export async function POST(request: Request) {
  const secret = process.env.PUSH_CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "not_configured" }, { status: 503 });

  const authHeader = request.headers.get("authorization") ?? "";
  const provided = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : "";
  if (!provided || !safeEqual(provided, secret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  if (!isPushConfigured()) return NextResponse.json({ error: "push_not_configured" }, { status: 503 });

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: "not_configured" }, { status: 503 });

  try {
    const result = await processDueReminders(admin);
    return NextResponse.json({ status: "ok", ...result });
  } catch {
    // Stage 37 §64 — no reminder/delivery detail in the response or in
    // any log line beyond this generic failure.
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
}
