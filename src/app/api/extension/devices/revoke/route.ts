import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { revokeDevice } from "@/lib/extension/devices";

/**
 * Revokes one of the signed-in user's own extension devices. The device's
 * next authenticated request is rejected (see /api/extension/progress),
 * but this never touches library items, collections, or tracking-source
 * mappings — revoking a device only stops it from writing further.
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });

  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  let body: { deviceId?: string };
  try {
    body = (await request.json()) as { deviceId?: string };
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  if (!body.deviceId) return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  try {
    await revokeDevice(supabase, userData.user.id, body.deviceId);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "failed" }, { status: 502 });
  }
}
