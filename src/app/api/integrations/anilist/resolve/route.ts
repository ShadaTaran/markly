import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isMediaItem } from "@/lib/item-detail";
import { diffMediaTrackingEvents } from "@/lib/activity-events";
import { fromLibraryItemRow, toLibraryItemRow } from "@/lib/cloud/library-items";
import { insertActivityEvent } from "@/lib/cloud/activity";
import { generateId } from "@/lib/utils";
import type { LibraryItemRow } from "@/lib/supabase/database.types";
import type { MediaItem } from "@/types/library-item";
import type { ActivityEventInput } from "@/types/activity";
import { mapAniListScore, mapAniListStatus, buildSyncBaseline } from "@/lib/integrations/anilist/mapping";

interface ResolveRequestBody {
  itemId?: string;
  resolution?: "markly" | "anilist";
  anilist?: {
    mediaId?: string;
    status?: string;
    progress?: number;
    score?: number | null;
    updatedAt?: number | null;
  };
}

/**
 * Resolves one Sync Now conflict. The AniList-side snapshot is supplied by
 * the client because it was already returned to that same client by the
 * preceding /sync call (public AniList data, not sensitive) — this avoids
 * a second AniList request per resolved conflict. Ownership of `itemId` is
 * still verified server-side against the authenticated user before any
 * write, and RLS enforces it independently.
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });

  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  let body: ResolveRequestBody;
  try {
    body = (await request.json()) as ResolveRequestBody;
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const { itemId, resolution, anilist } = body;
  if (!itemId || (resolution !== "markly" && resolution !== "anilist") || !anilist?.mediaId || !anilist.status) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const { data: rows, error: fetchError } = await supabase
    .from("library_items")
    .select("*")
    .eq("id", itemId)
    .eq("user_id", userData.user.id)
    .returns<LibraryItemRow[]>();
  if (fetchError) return NextResponse.json({ error: "lookup_failed" }, { status: 502 });
  const row = rows?.[0];
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let current: MediaItem;
  try {
    const parsed = fromLibraryItemRow(row);
    if (!isMediaItem(parsed)) throw new Error("not a media item");
    current = parsed;
  } catch {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const syncedAt = new Date().toISOString();
  const baselineEntry = {
    status: anilist.status,
    score: anilist.score ?? null,
    progress: anilist.progress ?? 0,
    updatedAt: anilist.updatedAt ?? null,
    media: { id: Number(anilist.mediaId) },
  };

  if (resolution === "markly") {
    const outRow = toLibraryItemRow(current, userData.user.id);
    outRow.metadata = { ...outRow.metadata, anilistSync: buildSyncBaseline(baselineEntry, syncedAt) };
    const { error } = await supabase.from("library_items").upsert(outRow);
    if (error) return NextResponse.json({ error: "save_failed" }, { status: 502 });
    return NextResponse.json({ ok: true });
  }

  const rating = mapAniListScore(anilist.score);
  const progress = anilist.progress ?? 0;
  const status = mapAniListStatus(anilist.status).markly;

  let patched: MediaItem;
  switch (current.type) {
    case "anime":
    case "series":
      patched = { ...current, status, rating, currentEpisode: progress, updatedAt: syncedAt };
      break;
    case "manga":
      patched = { ...current, status, rating, currentChapter: progress, updatedAt: syncedAt };
      break;
    case "novel":
    case "movie":
    case "game":
      patched = current;
      break;
  }

  const events: ActivityEventInput[] = diffMediaTrackingEvents(current.id, current, patched).map((event) => ({
    ...event,
    source: "anilist_sync" as const,
  }));

  const outRow = toLibraryItemRow(patched, userData.user.id);
  outRow.metadata = { ...outRow.metadata, anilistSync: buildSyncBaseline(baselineEntry, syncedAt) };

  const { error: writeError } = await supabase.from("library_items").upsert(outRow);
  if (writeError) return NextResponse.json({ error: "save_failed" }, { status: 502 });

  for (const event of events) {
    await insertActivityEvent(supabase, { ...event, id: generateId(), timestamp: syncedAt }, userData.user.id).catch(() => undefined);
  }

  return NextResponse.json({ ok: true });
}

