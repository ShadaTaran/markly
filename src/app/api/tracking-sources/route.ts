import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { listSources, listSourcesForItem, createManualSource, type TrackingSourceRow } from "@/lib/extension/tracking-sources";
import type { TrackingSourceSummary } from "@/lib/extension/types";
import { isValidUrl, normalizeUrl } from "@/lib/website";

const MAX_LABEL_LENGTH = 100;

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

/**
 * Stage 40 — "Add Source": creates (or links/reports a conflict on) a
 * manual tracking source. The URL is re-validated here with the exact same
 * lib/website.ts policy the UI already enforces — never trust client-side
 * validation alone, since this route is reachable directly.
 *
 * Data-integrity correction: this contract used to also accept a client-
 * supplied `mediaType` and pass it straight through to the inserted row.
 * That was a real gap, not a hardening nicety — `tracking_sources`'
 * `media_type` column has its own independent CHECK constraint; nothing
 * ties it to the actual type of the LibraryItem it's linked to. RLS proves
 * OWNERSHIP of `libraryItemId` (0003's WITH CHECK), but never validated
 * that the declared mediaType matched that item's real, stored type — so a
 * caller who owned a *website* item could still have requested
 * `mediaType: "anime"` and gotten a tracking_sources row created against
 * it. `mediaType` is no longer part of this request at all: createManualSource
 * now loads the target LibraryItem itself and uses ITS stored type as the
 * only source of truth (also see that function's own doc comment).
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });

  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  let body: { libraryItemId?: string; url?: string; label?: string };
  try {
    body = (await request.json()) as { libraryItemId?: string; url?: string; label?: string };
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  if (!body.libraryItemId || !body.url) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const normalized = normalizeUrl(body.url);
  if (!isValidUrl(normalized)) {
    return NextResponse.json({ error: "invalid_url" }, { status: 400 });
  }

  const label = (body.label ?? "").trim().slice(0, MAX_LABEL_LENGTH) || new URL(normalized).hostname.replace(/^www\./, "");

  try {
    const result = await createManualSource(supabase, userData.user.id, body.libraryItemId, normalized, label);
    if (result.status === "item-not-found") {
      // Deliberately the same generic shape/status regardless of whether
      // libraryItemId names another account's item or nothing at all — see
      // createManualSource's own doc comment on why those two cases must
      // stay indistinguishable to the caller.
      return NextResponse.json({ error: "item_not_found" }, { status: 404 });
    }
    if (result.status === "unsupported-item-type") {
      // Safe to be specific here: the caller already owns this item (just
      // confirmed above), so telling them its type doesn't support sources
      // reveals nothing about anyone else's data.
      return NextResponse.json({ error: "unsupported_item_type" }, { status: 400 });
    }
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: "create_failed" }, { status: 502 });
  }
}
