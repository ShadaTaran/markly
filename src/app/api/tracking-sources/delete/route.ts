import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { deleteUnlinkedManualSource } from "@/lib/extension/tracking-sources";

/**
 * Stage 42 — permanently erases an UNLINKED MANUAL TrackingSource row.
 * The request body carries only `sourceId`: adapter_id, library_item_id,
 * user_id, and every other identifying detail are derived server-side
 * from the authenticated session and the real database row, never taken
 * from the client (see deleteUnlinkedManualSource's own doc comment for
 * why unlinked+manual is the only eligible class, and why that check is
 * the DELETE statement's own atomic WHERE clause, not a prior read).
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });

  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  let body: { sourceId?: string };
  try {
    body = (await request.json()) as { sourceId?: string };
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  if (!body.sourceId) return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  try {
    const result = await deleteUnlinkedManualSource(supabase, userData.user.id, body.sourceId);
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: "delete_failed" }, { status: 502 });
  }
}
