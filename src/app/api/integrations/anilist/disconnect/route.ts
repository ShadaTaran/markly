import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { deleteConnection } from "@/lib/integrations/connections";

/**
 * Removes Markly's stored connection/token for this user. AniList exposes
 * no applicable token-revocation endpoint to call here — this removes
 * Markly's own copy, it does not (and cannot claim to) revoke access on
 * AniList's side. Imported library items, collections, and activity are
 * left entirely untouched.
 */
export async function POST() {
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });

  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  try {
    await deleteConnection(supabase, userData.user.id, "anilist");
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "disconnect_failed" }, { status: 502 });
  }
}
