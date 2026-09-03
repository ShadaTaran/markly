import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { listSources } from "@/lib/extension/tracking-sources";

export async function GET() {
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });

  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  try {
    const rows = await listSources(supabase, userData.user.id);
    const sources = rows.map((row) => ({
      id: row.id,
      adapterId: row.adapter_id,
      sourceTitle: row.source_title,
      sourceUrl: row.source_url,
      mediaType: row.media_type,
      libraryItemId: row.library_item_id,
      autoTrackEnabled: row.auto_track_enabled,
      lastDetectedProgress: row.last_detected_progress
        ? { kind: row.last_detected_progress.kind, value: row.last_detected_progress.value, confirmed: row.last_detected_progress.confirmed }
        : null,
      lastDetectedMetadata: row.last_detected_progress?.metadata,
      lastSeenAt: row.last_seen_at,
    }));
    return NextResponse.json({ sources });
  } catch {
    return NextResponse.json({ error: "failed" }, { status: 502 });
  }
}
