import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createPairingCode } from "@/lib/extension/pairing";

/**
 * Generates a short-lived, one-time pairing code for the signed-in user —
 * called from the Auto Tracking settings page. The code is shown once in
 * the web app and typed into the extension popup; only its hash is ever
 * stored (see lib/extension/tokens.ts).
 */
export async function POST() {
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });

  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  try {
    const { code, expiresAt } = await createPairingCode(supabase, userData.user.id);
    return NextResponse.json({ code, expiresAt });
  } catch {
    return NextResponse.json({ error: "failed" }, { status: 502 });
  }
}
