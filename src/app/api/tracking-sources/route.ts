import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { listSources, listSourcesForItem, type TrackingSourceRow } from "@/lib/extension/tracking-sources";
import type { TrackingSourceSummary } from "@/lib/extension/types";

function toSummary(row: TrackingSourceRow): TrackingSourceSummary {
  return {
    id: row.id,
    adapterId: row.adapter_id,
    sourceTitle: row.source_title,
    sourceUrl: row.source_url,
    mediaType: row.media_type,
    libraryItemId: row.library_item_id,
    autoTrackEnabled: row.auto_track_enabled,
    // Stage 26 bugfix: this mapping previously dropped `season`, so a
    // seasonal source's last-detected progress silently lost its season
    // here even though the underlying column always had it (Stage 25
    // widened last_detected_progress's JSONB shape correctly — this one
    // read site just wasn't updated to match).
    lastDetectedProgress: row.last_detected_progress
      ? {
          kind: row.last_detected_progress.kind,
          value: row.last_detected_progress.value,
          season: row.last_detected_progress.season,
          confirmed: row.last_detected_progress.confirmed,
        }
      : null,
    lastDetectedMetadata: row.last_detected_progress?.metadata,
    lastSeenAt: row.last_seen_at,
    autoLinkSuppressed: row.auto_link_suppressed_at !== null,
  };
}

/**
 * `?libraryItemId=<id>` scopes to one item's sources — the query the item
 * detail page's Tracking Sources section uses, so it never fetches every
 * source the user has (see README "Cross-Source Work Identity" — avoiding
 * over-fetching was an explicit requirement). Omitted, this returns every
 * source, unchanged from before Stage 26 — the Settings page's use case.
 */
export async function GET(request: Request) {
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });

  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const libraryItemId = new URL(request.url).searchParams.get("libraryItemId");

  try {
    const rows = libraryItemId
      ? await listSourcesForItem(supabase, userData.user.id, libraryItemId)
      : await listSources(supabase, userData.user.id);
    return NextResponse.json({ sources: rows.map(toSummary) });
  } catch {
    return NextResponse.json({ error: "failed" }, { status: 502 });
  }
}
