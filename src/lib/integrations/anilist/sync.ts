import type { SupabaseClient } from "@supabase/supabase-js";
import { generateId } from "@/lib/utils";
import { isMediaItem } from "@/lib/item-detail";
import { createMediaItem } from "@/lib/library-items";
import { diffMediaTrackingEvents } from "@/lib/activity-events";
import { toLibraryItemRow, fromLibraryItemRow } from "@/lib/cloud/library-items";
import { insertActivityEvent } from "@/lib/cloud/activity";
import type { LibraryItemInsert, LibraryItemRow } from "@/lib/supabase/database.types";
import type { MediaItem } from "@/types/library-item";
import type { ActivityEventInput } from "@/types/activity";
import type { MetadataDetails } from "@/lib/metadata/types";
import type { PersonalTrackingValues } from "@/components/CatalogTrackingForm";
import { buildCatalogMediaInput } from "@/lib/metadata/catalog-item";
import { anilistGraphQL } from "@/lib/integrations/anilist/client";
import {
  MEDIA_LISTS_QUERY,
  flattenEntries,
  type AniListAnimeMedia,
  type AniListListEntry,
  type AniListMangaMedia,
  type AniListMediaListsResponse,
} from "@/lib/integrations/anilist/queries";
import {
  mapAnimeMediaToCatalog,
  mapMangaMediaToCatalog,
  mapEntryToPersonalTracking,
  mapAniListStatus,
  mapAniListScore,
  buildSyncBaseline,
  readSyncBaseline,
  type AniListEntryFields,
} from "@/lib/integrations/anilist/mapping";
import type { SyncConflict, SyncResult } from "@/lib/integrations/types";

const LIBRARY_TABLE = "library_items";

export interface AniListLibraryCounts {
  anime: number;
  manga: number;
}

/** Fetches both lists in one GraphQL request — used for both the preview screen and the actual import/sync. */
async function fetchLists(accessToken: string, anilistUserId: number): Promise<AniListMediaListsResponse> {
  return anilistGraphQL<AniListMediaListsResponse>(accessToken, MEDIA_LISTS_QUERY, { userId: anilistUserId });
}

export async function previewAniListLibrary(accessToken: string, anilistUserId: number): Promise<AniListLibraryCounts> {
  const data = await fetchLists(accessToken, anilistUserId);
  return {
    anime: flattenEntries(data.anime).length,
    manga: flattenEntries(data.manga).length,
  };
}

/** Existing anime/manga rows for this user, fetched once and matched in memory by AniList media id — never one query per AniList entry. */
async function fetchExistingRows(supabase: SupabaseClient, userId: string): Promise<LibraryItemRow[]> {
  const { data, error } = await supabase
    .from(LIBRARY_TABLE)
    .select("*")
    .eq("user_id", userId)
    .in("type", ["anime", "manga"])
    .returns<LibraryItemRow[]>();
  if (error) throw error;
  return data ?? [];
}

function readExternalId(row: LibraryItemRow): string | undefined {
  const source = row.metadata.catalogSource;
  if (!source || typeof source !== "object") return undefined;
  const candidate = source as Record<string, unknown>;
  return candidate.provider === "anilist" && typeof candidate.externalId === "string" ? candidate.externalId : undefined;
}

function getProgress(item: MediaItem): number | undefined {
  if (item.type === "anime" || item.type === "series") return item.currentEpisode;
  if (item.type === "manga") return item.currentChapter;
  return undefined;
}

function progressLabel(kind: "anime" | "manga", value: number): string {
  return kind === "anime" ? `Episode ${value}` : `Chapter ${value}`;
}

function anilistStatusLabel(anilistStatus: string): string {
  return marklyStatusLabel(mapAniListStatus(anilistStatus).markly);
}

interface PendingRow {
  row: LibraryItemInsert;
  events: ActivityEventInput[];
}

export interface RunSyncOptions {
  includeAnime: boolean;
  includeManga: boolean;
  /**
   * False for the first bulk import: importing dozens/hundreds of
   * pre-existing AniList entries must not flood Recent Activity with
   * events dated today representing historical AniList state (item_added
   * for new items, or progress/status/rating for existing matches). True
   * for later "Sync Now" runs, where a small number of genuine changes
   * since the last sync are worth showing. The library write itself
   * (and the per-item anilistSync baseline) happens identically either
   * way — only whether an activity event accompanies it differs.
   */
  recordActivity: boolean;
}

interface SyncAccumulator {
  pending: PendingRow[];
  conflicts: SyncConflict[];
  imported: number;
  updated: number;
  unchanged: number;
  skipped: number;
}

function handleNewItem(
  acc: SyncAccumulator,
  kind: "anime" | "manga",
  catalogData: MetadataDetails,
  entry: AniListEntryFields,
  userId: string,
  syncedAt: string,
  recordActivity: boolean,
) {
  try {
    const personal = mapEntryToPersonalTracking(entry);
    const personalValues: PersonalTrackingValues = {
      status: personal.status,
      rating: personal.rating,
      currentEpisode: kind === "anime" ? personal.progress : undefined,
      currentChapter: kind === "manga" ? personal.progress : undefined,
    };
    const mediaInput = buildCatalogMediaInput(kind, catalogData, personalValues);
    const newItem = createMediaItem(kind, generateId(), syncedAt, mediaInput);
    const row = toLibraryItemRow(newItem, userId);
    row.metadata = { ...row.metadata, anilistSync: buildSyncBaseline(entry, syncedAt) };
    // A first bulk import represents pre-existing AniList state, not a
    // user action taken in Markly today — no item_added event then (see
    // RunSyncOptions.recordActivity). Later syncs that discover a
    // genuinely new AniList entry still get the normal item_added event.
    const events: ActivityEventInput[] = recordActivity ? [{ type: "item_added", itemId: newItem.id }] : [];
    acc.pending.push({ row, events });
    acc.imported += 1;
  } catch {
    acc.skipped += 1;
  }
}

function handleExistingItem(
  acc: SyncAccumulator,
  kind: "anime" | "manga",
  entry: AniListEntryFields,
  title: string,
  existingRow: LibraryItemRow,
  userId: string,
  syncedAt: string,
  recordActivity: boolean,
) {
  let current: MediaItem;
  try {
    const parsed = fromLibraryItemRow(existingRow);
    if (!isMediaItem(parsed)) throw new Error("not a media item");
    current = parsed;
  } catch {
    acc.skipped += 1;
    return;
  }

  const incoming = mapEntryToPersonalTracking(entry);
  const marklyProgress = getProgress(current) ?? 0;
  const baseline = readSyncBaseline(existingRow.metadata);

  const recordBaselineOnly = () => {
    const row = toLibraryItemRow(current, userId);
    row.metadata = { ...row.metadata, anilistSync: buildSyncBaseline(entry, syncedAt) };
    acc.pending.push({ row, events: [] });
  };

  const applyUpdate = () => {
    const updatedAt = syncedAt;
    // fetchExistingRows only ever fetches type IN ('anime','manga'), so
    // `current` is guaranteed to be one of those two here — the switch is
    // still exhaustive over the full MediaItem union (no cast) so an
    // unrelated type can never silently fall through.
    let patched: MediaItem;
    switch (current.type) {
      case "anime":
      case "series":
        patched = { ...current, status: incoming.status, rating: incoming.rating, currentEpisode: incoming.progress, updatedAt };
        break;
      case "manga":
        patched = { ...current, status: incoming.status, rating: incoming.rating, currentChapter: incoming.progress, updatedAt };
        break;
      case "novel":
      case "movie":
      case "game":
        patched = current;
        break;
    }
    // Same reasoning as handleNewItem: a first bulk import must not
    // synthesize progress/status/rating activity representing AniList
    // state that predates this import — only later syncs, where these
    // events reflect a genuine change since the last sync, log them.
    const events: ActivityEventInput[] = recordActivity
      ? diffMediaTrackingEvents(current.id, current, patched).map((event) => ({ ...event, source: "anilist_sync" as const }))
      : [];
    const row = toLibraryItemRow(patched, userId);
    row.metadata = { ...row.metadata, anilistSync: buildSyncBaseline(entry, syncedAt) };
    acc.pending.push({ row, events });
    acc.updated += 1;
  };

  const pushConflict = (field: SyncConflict["field"], marklyValue: string, anilistValue: string) => {
    acc.conflicts.push({
      itemId: current.id,
      title,
      field,
      markly: { label: field, value: marklyValue },
      anilist: {
        label: field,
        value: anilistValue,
        mediaId: entry.media.id.toString(),
        status: entry.status,
        progress: entry.progress ?? 0,
        score: entry.score,
        updatedAt: entry.updatedAt,
      },
    });
  };

  // Manga progress can be a Markly-entered decimal (split-release
  // chapters); AniList's integer progress must never silently truncate
  // that — surface it as a conflict instead of overwriting.
  const decimalGuard = kind === "manga" && !Number.isInteger(marklyProgress) && marklyProgress !== incoming.progress;

  if (!baseline) {
    const differs = current.status !== incoming.status || marklyProgress !== incoming.progress || (current.rating ?? undefined) !== incoming.rating;
    if (!differs) {
      recordBaselineOnly();
      acc.unchanged += 1;
      return;
    }
    if (decimalGuard) {
      pushConflict("progress", String(marklyProgress), String(incoming.progress));
      return;
    }
    if (current.status !== incoming.status) {
      pushConflict("status", marklyStatusLabel(current.status), anilistStatusLabel(entry.status));
      return;
    }
    if (marklyProgress !== incoming.progress) {
      pushConflict("progress", progressLabel(kind, marklyProgress), progressLabel(kind, incoming.progress));
      return;
    }
    pushConflict("rating", String(current.rating ?? "Unrated"), String(incoming.rating ?? "Unrated"));
    return;
  }

  const expectedStatus = mapAniListStatus(baseline.status).markly;
  const expectedRating = mapAniListScore(baseline.score);
  const marklyChanged = current.status !== expectedStatus || marklyProgress !== baseline.progress || (current.rating ?? undefined) !== expectedRating;
  const anilistChanged = entry.status !== baseline.status || (entry.progress ?? 0) !== baseline.progress || (entry.score ?? null) !== baseline.score;

  if (!anilistChanged) {
    acc.unchanged += 1;
    return;
  }

  if (!marklyChanged) {
    applyUpdate();
    return;
  }

  if (decimalGuard) {
    pushConflict("progress", String(marklyProgress), String(incoming.progress));
    return;
  }
  if (current.status !== incoming.status) {
    pushConflict("status", marklyStatusLabel(current.status), anilistStatusLabel(entry.status));
    return;
  }
  if (marklyProgress !== incoming.progress) {
    pushConflict("progress", progressLabel(kind, marklyProgress), progressLabel(kind, incoming.progress));
    return;
  }
  pushConflict("rating", String(current.rating ?? "Unrated"), String(incoming.rating ?? "Unrated"));
}

const MARKLY_STATUS_LABELS: Record<MediaItem["status"], string> = {
  planned: "Planned",
  in_progress: "In Progress",
  completed: "Completed",
  on_hold: "On Hold",
  dropped: "Dropped",
};

function marklyStatusLabel(status: MediaItem["status"]): string {
  return MARKLY_STATUS_LABELS[status];
}

function processAnime(
  acc: SyncAccumulator,
  entries: AniListListEntry<AniListAnimeMedia>[],
  existingByMediaId: Map<string, LibraryItemRow>,
  userId: string,
  syncedAt: string,
  recordActivity: boolean,
) {
  entries.forEach((entry) => {
    const mediaId = entry.media.id.toString();
    const title = entry.media.title.english || entry.media.title.romaji || "Untitled";
    const existingRow = existingByMediaId.get(mediaId);
    if (existingRow) {
      handleExistingItem(acc, "anime", entry, title, existingRow, userId, syncedAt, recordActivity);
    } else {
      handleNewItem(acc, "anime", mapAnimeMediaToCatalog(entry.media), entry, userId, syncedAt, recordActivity);
    }
  });
}

function processManga(
  acc: SyncAccumulator,
  entries: AniListListEntry<AniListMangaMedia>[],
  existingByMediaId: Map<string, LibraryItemRow>,
  userId: string,
  syncedAt: string,
  recordActivity: boolean,
) {
  entries.forEach((entry) => {
    const mediaId = entry.media.id.toString();
    const title = entry.media.title.english || entry.media.title.romaji || "Untitled";
    const existingRow = existingByMediaId.get(mediaId);
    if (existingRow) {
      handleExistingItem(acc, "manga", entry, title, existingRow, userId, syncedAt, recordActivity);
    } else {
      handleNewItem(acc, "manga", mapMangaMediaToCatalog(entry.media), entry, userId, syncedAt, recordActivity);
    }
  });
}

/**
 * The single sync engine behind both first import and later "Sync Now" —
 * they differ in which AniList entries are considered (import can be
 * scoped to one type via `options.includeAnime`/`includeManga`; sync
 * always processes both) and in whether activity events accompany the
 * writes (`options.recordActivity` — see its doc comment). Every write is
 * a bulk upsert by stable id (library_items.id for existing rows, a fresh
 * id for new ones) — never a destructive rebuild — so a single malformed
 * AniList entry is skipped and counted, not fatal to the rest of the run.
 */
export async function runAniListSync(
  supabase: SupabaseClient,
  userId: string,
  accessToken: string,
  anilistUserId: number,
  options: RunSyncOptions,
): Promise<SyncResult> {
  const [existingRows, lists] = await Promise.all([fetchExistingRows(supabase, userId), fetchLists(accessToken, anilistUserId)]);

  const existingByMediaId = new Map<string, LibraryItemRow>();
  existingRows.forEach((row) => {
    const externalId = readExternalId(row);
    if (externalId) existingByMediaId.set(externalId, row);
  });

  const syncedAt = new Date().toISOString();
  const acc: SyncAccumulator = { pending: [], conflicts: [], imported: 0, updated: 0, unchanged: 0, skipped: 0 };

  if (options.includeAnime) processAnime(acc, flattenEntries(lists.anime), existingByMediaId, userId, syncedAt, options.recordActivity);
  if (options.includeManga) processManga(acc, flattenEntries(lists.manga), existingByMediaId, userId, syncedAt, options.recordActivity);

  if (acc.pending.length > 0) {
    const { error } = await supabase.from(LIBRARY_TABLE).upsert(acc.pending.map((entry) => entry.row));
    if (error) throw error;
  }

  for (const entry of acc.pending) {
    for (const event of entry.events) {
      // Best-effort: a failed activity insert must not undo an already-
      // persisted library update.
      await insertActivityEvent(supabase, { ...event, id: generateId(), timestamp: syncedAt }, userId).catch(() => undefined);
    }
  }

  return { imported: acc.imported, updated: acc.updated, unchanged: acc.unchanged, skipped: acc.skipped, conflicts: acc.conflicts };
}
