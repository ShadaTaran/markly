import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { setAutoAddEnabled } from "@/lib/extension/devices";

/**
 * Toggles Stage 22's "Automatically add new works" preference for one of
 * the signed-in user's own devices. Session-authenticated and RLS-scoped
 * (the same pattern as /api/extension/devices/revoke) — this is the single
 * place the preference is written; the extension popup never maintains a
 * separate copy of it (see README "Optional Zero-Touch Auto-Add").
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });

  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  let body: { deviceId?: string; enabled?: boolean };
  try {
    body = (await request.json()) as { deviceId?: string; enabled?: boolean };
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  if (!body.deviceId || typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  try {
    await setAutoAddEnabled(supabase, userData.user.id, body.deviceId, body.enabled);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "failed" }, { status: 502 });
  }
}
