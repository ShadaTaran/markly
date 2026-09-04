import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { setAutoTrackEnabled } from "@/lib/extension/tracking-sources";

/**
 * Stage 26 — `tracking_sources.auto_track_enabled` and its server-side
 * enforcement (POST /api/extension/progress returns "tracking_disabled"
 * before ever committing progress for a disabled source — see route.ts)
 * both already existed since Stage 18/22; this is simply the first route
 * that lets a user actually flip it, matching the toggle-route pattern
 * already used for device-level Auto-Add (/api/extension/devices/auto-add).
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });

  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  let body: { sourceId?: string; enabled?: boolean };
  try {
    body = (await request.json()) as { sourceId?: string; enabled?: boolean };
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  if (!body.sourceId || typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  try {
    await setAutoTrackEnabled(supabase, userData.user.id, body.sourceId, body.enabled);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "toggle_failed" }, { status: 502 });
  }
}
