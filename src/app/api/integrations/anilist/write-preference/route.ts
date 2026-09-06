import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { setAllowAniListWrites } from "@/lib/integrations/connections";

interface WritePreferenceBody {
  allow?: boolean;
}

/**
 * Stage 30 — toggles "Allow Markly to update AniList" (default OFF,
 * §3/§16). This alone never performs a mutation; it only changes whether
 * a LATER, explicitly-reviewed Apply is permitted to send outbound
 * writes — enforced again, independently, inside applyWritebackItem
 * (§34) so a stale or forged client request can never bypass this by
 * pretending the preference is already on.
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });

  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  let body: WritePreferenceBody;
  try {
    body = (await request.json()) as WritePreferenceBody;
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  if (typeof body.allow !== "boolean") {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  try {
    await setAllowAniListWrites(supabase, userData.user.id, body.allow);
    return NextResponse.json({ ok: true, allow: body.allow });
  } catch (error) {
    if (error instanceof Error && error.message === "not_connected") {
      return NextResponse.json({ error: "not_connected" }, { status: 404 });
    }
    return NextResponse.json({ error: "save_failed" }, { status: 502 });
  }
}
