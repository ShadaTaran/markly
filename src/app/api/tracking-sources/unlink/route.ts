import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { unlinkSource } from "@/lib/extension/tracking-sources";

/** Unlinking only clears library_item_id on the mapping — the LibraryItem and its history are never touched. */
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
    await unlinkSource(supabase, userData.user.id, body.sourceId);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "unlink_failed" }, { status: 502 });
  }
}
