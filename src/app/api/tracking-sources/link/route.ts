import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { linkSource } from "@/lib/extension/tracking-sources";

/**
 * Links a detected source to one of the user's own LibraryItems. Ownership
 * of both rows is enforced twice: here (the update is scoped to
 * user_id = the signed-in user) and independently by the tracking_sources
 * RLS policy's WITH CHECK, which re-verifies the target library item also
 * belongs to auth.uid() — see the Stage 18 migration.
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });

  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  let body: { sourceId?: string; libraryItemId?: string };
  try {
    body = (await request.json()) as { sourceId?: string; libraryItemId?: string };
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  if (!body.sourceId || !body.libraryItemId) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  try {
    await linkSource(supabase, userData.user.id, body.sourceId, body.libraryItemId);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "link_failed" }, { status: 502 });
  }
}
