import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { listDevices } from "@/lib/extension/devices";

export async function GET() {
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });

  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  try {
    const devices = await listDevices(supabase, userData.user.id);
    return NextResponse.json({ devices });
  } catch {
    return NextResponse.json({ error: "failed" }, { status: 502 });
  }
}
