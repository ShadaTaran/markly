import type { SupabaseClient } from "@supabase/supabase-js";
import type { LibraryItemInsert, LibraryItemRow } from "@/lib/supabase/database.types";
import type { CatalogSourceReference, LibraryItem, MediaItem, MetadataProvider } from "@/types/library-item";
import { isMediaItem } from "@/lib/item-detail";
import {
  normalizeEpisodeNumbering,
  normalizeNonNegativeInt,
  normalizeNonNegativeNumber,
  normalizePositiveInt,
  normalizeProgressUnit,
  normalizeRating,
  normalizeReadingFormat,
  normalizeStatus,
} from "@/lib/tracking";

type Metadata = Record<string, unknown>;

function readMetadata(row: LibraryItemRow): Metadata {
  return row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata) ? row.metadata : {};
}

function readString(meta: Metadata, key: string): string | undefined {
  const value = meta[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(meta: Metadata, key: string): number | undefined {
  const value = meta[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readStringArray(meta: Metadata, key: string): string[] | undefined {
  const value = meta[key];
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : undefined;
}

function readCatalogSource(meta: Metadata, key: string): CatalogSourceReference | undefined {
  const value = meta[key];
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  // Mirrors isValidCatalogSource in lib/library-storage.ts: checks shape,
  // not literal MetadataProvider membership — the same leniency the local
  // storage validator already accepts for this field.
  if (typeof candidate.provider !== "string" || typeof candidate.externalId !== "string") return undefined;
  return { provider: candidate.provider as MetadataProvider, externalId: candidate.externalId };
}

/** Reconstructs a LibraryItem from its database row. Switch-based per type, matching the codebase's discriminated-union convention. */
export function fromLibraryItemRow(row: LibraryItemRow): LibraryItem {
  const meta = readMetadata(row);
  const base = {
    id: row.id,
    title: row.title,
    description: row.description,
    category: row.category,
    tags: row.tags,
    favorite: row.favorite,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? undefined,
  };

  if (row.type === "website") {
    return { ...base, type: "website", url: row.url ?? "" };
  }

  const mediaBase = {
    ...base,
    imageUrl: row.image_url ?? undefined,
    sourceUrl: row.source_url ?? undefined,
    status: normalizeStatus(row.status),
    rating: normalizeRating(row.rating),
    releaseYear: readNumber(meta, "releaseYear"),
    catalogSource: readCatalogSource(meta, "catalogSource"),
  };

  switch (row.type) {
    case "anime":
      return {
        ...mediaBase,
        type: "anime",
        currentEpisode: normalizeNonNegativeInt(readNumber(meta, "currentEpisode")),
        totalEpisodes: normalizePositiveInt(readNumber(meta, "totalEpisodes")),
        episodeNumbering: normalizeEpisodeNumbering(readString(meta, "episodeNumbering")),
        currentSeason: normalizePositiveInt(readNumber(meta, "currentSeason")),
        genres: readStringArray(meta, "genres"),
        studio: readString(meta, "studio"),
      };
    case "series":
      return {
        ...mediaBase,
        type: "series",
        currentEpisode: normalizeNonNegativeInt(readNumber(meta, "currentEpisode")),
        totalEpisodes: normalizePositiveInt(readNumber(meta, "totalEpisodes")),
        episodeNumbering: normalizeEpisodeNumbering(readString(meta, "episodeNumbering")),
        currentSeason: normalizePositiveInt(readNumber(meta, "currentSeason")),
        genres: readStringArray(meta, "genres"),
      };
    case "manga":
      return {
        ...mediaBase,
        type: "manga",
        currentChapter: normalizeNonNegativeNumber(readNumber(meta, "currentChapter")),
        totalChapters: normalizePositiveInt(readNumber(meta, "totalChapters")),
        genres: readStringArray(meta, "genres"),
        authors: readStringArray(meta, "authors"),
      };
    case "novel":
      return {
        ...mediaBase,
        type: "novel",
        progressValue: readNumber(meta, "progressValue"),
        progressUnit: normalizeProgressUnit(readString(meta, "progressUnit")),
        authors: readStringArray(meta, "authors"),
        pageCount: readNumber(meta, "pageCount"),
        readingFormat: normalizeReadingFormat(readString(meta, "readingFormat")),
      };
    case "movie":
      return { ...mediaBase, type: "movie", genres: readStringArray(meta, "genres") };
    case "game":
      return {
        ...mediaBase,
        type: "game",
        platform: readString(meta, "platform"),
        playtimeHours: normalizeNonNegativeNumber(readNumber(meta, "playtimeHours")),
        developer: readString(meta, "developer"),
        publisher: readString(meta, "publisher"),
        catalogPlatforms: readStringArray(meta, "catalogPlatforms"),
      };
    default:
      // Unknown/unsupported type (the article/video/other placeholder, or a
      // future row this client version doesn't understand) — surface it as
      // the generic placeholder rather than crashing the whole library load.
      return { ...base, type: "other" };
  }
}

/** Maps a LibraryItem to its database row shape for insert/upsert. */
export function toLibraryItemRow(item: LibraryItem, userId: string): LibraryItemInsert {
  const common = {
    id: item.id,
    user_id: userId,
    type: item.type,
    title: item.title,
    description: item.description,
    category: item.category,
    tags: item.tags,
    favorite: item.favorite,
    created_at: item.createdAt,
    updated_at: item.updatedAt ?? null,
  };

  if (item.type === "website") {
    return { ...common, url: item.url, image_url: null, source_url: null, status: null, rating: null, metadata: {} };
  }

  if (!isMediaItem(item)) {
    // Generic placeholder type (article/video/other) — no dedicated schema
    // yet; persisted with base fields only, matching its local shape.
    return { ...common, url: null, image_url: null, source_url: null, status: null, rating: null, metadata: {} };
  }

  const metadata: Metadata = {};
  if (item.releaseYear !== undefined) metadata.releaseYear = item.releaseYear;
  if (item.catalogSource !== undefined) metadata.catalogSource = item.catalogSource;

  switch (item.type) {
    case "anime":
      if (item.currentEpisode !== undefined) metadata.currentEpisode = item.currentEpisode;
      if (item.totalEpisodes !== undefined) metadata.totalEpisodes = item.totalEpisodes;
      if (item.episodeNumbering !== undefined) metadata.episodeNumbering = item.episodeNumbering;
      if (item.currentSeason !== undefined) metadata.currentSeason = item.currentSeason;
      if (item.genres !== undefined) metadata.genres = item.genres;
      if (item.studio !== undefined) metadata.studio = item.studio;
      break;
    case "series":
      if (item.currentEpisode !== undefined) metadata.currentEpisode = item.currentEpisode;
      if (item.totalEpisodes !== undefined) metadata.totalEpisodes = item.totalEpisodes;
      if (item.episodeNumbering !== undefined) metadata.episodeNumbering = item.episodeNumbering;
      if (item.currentSeason !== undefined) metadata.currentSeason = item.currentSeason;
      if (item.genres !== undefined) metadata.genres = item.genres;
      break;
    case "manga":
      if (item.currentChapter !== undefined) metadata.currentChapter = item.currentChapter;
      if (item.totalChapters !== undefined) metadata.totalChapters = item.totalChapters;
      if (item.genres !== undefined) metadata.genres = item.genres;
      if (item.authors !== undefined) metadata.authors = item.authors;
      break;
    case "novel":
      if (item.progressValue !== undefined) metadata.progressValue = item.progressValue;
      if (item.progressUnit !== undefined) metadata.progressUnit = item.progressUnit;
      if (item.authors !== undefined) metadata.authors = item.authors;
      if (item.pageCount !== undefined) metadata.pageCount = item.pageCount;
      if (item.readingFormat !== undefined) metadata.readingFormat = item.readingFormat;
      break;
    case "movie":
      if (item.genres !== undefined) metadata.genres = item.genres;
      break;
    case "game":
      if (item.platform !== undefined) metadata.platform = item.platform;
      if (item.playtimeHours !== undefined) metadata.playtimeHours = item.playtimeHours;
      if (item.developer !== undefined) metadata.developer = item.developer;
      if (item.publisher !== undefined) metadata.publisher = item.publisher;
      if (item.catalogPlatforms !== undefined) metadata.catalogPlatforms = item.catalogPlatforms;
      break;
  }

  return {
    ...common,
    url: null,
    image_url: item.imageUrl ?? null,
    source_url: item.sourceUrl ?? null,
    status: item.status,
    rating: item.rating ?? null,
    metadata,
  };
}

export async function fetchLibraryItems(supabase: SupabaseClient, userId: string): Promise<LibraryItem[]> {
  const { data, error } = await supabase
    .from("library_items")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .returns<LibraryItemRow[]>();

  if (error) throw error;
  return (data ?? []).map(fromLibraryItemRow);
}

export async function upsertLibraryItem(supabase: SupabaseClient, item: LibraryItem, userId: string): Promise<void> {
  const { error } = await supabase.from("library_items").upsert(toLibraryItemRow(item, userId));
  if (error) throw error;
}

export async function deleteLibraryItemRow(supabase: SupabaseClient, id: string): Promise<void> {
  const { error } = await supabase.from("library_items").delete().eq("id", id);
  if (error) throw error;
}

export type MergeLibraryItemsStatus =
  | "merged"
  | "unauthorized"
  | "same_item"
  | "not_found"
  | "type_mismatch"
  | "numbering_mode_conflict"
  | "progress_unit_conflict"
  | "catalog_source_conflict";

export interface MergeLibraryItemsResult {
  status: MergeLibraryItemsStatus;
}

const MERGE_STATUSES: readonly MergeLibraryItemsStatus[] = [
  "merged",
  "unauthorized",
  "same_item",
  "not_found",
  "type_mismatch",
  "numbering_mode_conflict",
  "progress_unit_conflict",
  "catalog_source_conflict",
];

function parseMergeResult(data: unknown): MergeLibraryItemsResult | null {
  if (!data || typeof data !== "object") return null;
  const status = (data as Record<string, unknown>).status;
  if (typeof status !== "string" || !(MERGE_STATUSES as readonly string[]).includes(status)) return null;
  return { status: status as MergeLibraryItemsStatus };
}

/**
 * Calls the atomic merge_library_items RPC (see
 * supabase/migrations/0009_stage27_merge_library_items.sql). `mergedItem`
 * is the client's already-reviewed field-merge computation
 * (src/lib/library-merge.ts's computeMergedLibraryItem) — trusted for
 * title/description/tags/genres/cover/catalogSource/etc., but the RPC
 * independently recomputes every progress-bearing field itself from
 * whatever the two rows actually contain at lock time (see the
 * migration's own doc comment for why: a TrackingSource can commit real
 * progress to the duplicate at any moment, including while this call is
 * in flight). Session-authenticated — never the admin client; ownership
 * is enforced inside the function via auth.uid(), not a client-supplied id.
 */
export async function mergeLibraryItems(
  supabase: SupabaseClient,
  survivorId: string,
  duplicateId: string,
  mergedItem: MediaItem,
  userId: string,
): Promise<MergeLibraryItemsResult> {
  const mergedRow = toLibraryItemRow(mergedItem, userId);
  const { data, error } = await supabase.rpc("merge_library_items", {
    p_survivor_id: survivorId,
    p_duplicate_id: duplicateId,
    p_merged_row: {
      title: mergedRow.title,
      description: mergedRow.description,
      category: mergedRow.category,
      tags: mergedRow.tags,
      favorite: mergedRow.favorite,
      image_url: mergedRow.image_url,
      source_url: mergedRow.source_url,
      status: mergedRow.status,
      rating: mergedRow.rating,
      metadata: mergedRow.metadata,
    },
  });
  if (error) throw error;

  const result = parseMergeResult(data);
  if (!result) throw new Error("merge_library_items returned an unexpected shape");
  return result;
}
