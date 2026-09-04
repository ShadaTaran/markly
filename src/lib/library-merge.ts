import type { AnimeItem, CatalogSourceReference, EpisodeNumbering, MediaItem, NovelItem, NovelProgressUnit, SeriesItem } from "@/types/library-item";

/**
 * Stage 27 — the field-merge policy shared by both local (authoritative
 * here) and cloud (preview-only here; the actual write is server-
 * authoritative for progress fields specifically — see
 * supabase/migrations/0009_stage27_merge_library_items.sql and
 * lib/cloud/library-items.ts's own doc comment for why) merge paths. Pure
 * and synchronous — no I/O, easy to unit test, and safe to call from a
 * live "Merge Preview" UI before anything destructive happens.
 *
 * Never fabricates a conversion the user didn't ask for (see README
 * "Numbering-mode conflict" / "Progress-unit conflict") — those cases
 * return `{status: "blocked"}` instead of guessing, and the caller must
 * refuse to offer a Merge button at all.
 */

export type MergeBlockReason =
  | "same_item"
  | "type_mismatch"
  | "numbering_mode_conflict"
  | "progress_unit_conflict"
  | "catalog_source_conflict";

export type MergeComputation = { status: "ok"; merged: MediaItem } | { status: "blocked"; reason: MergeBlockReason };

/** Human-readable, non-jargon explanations for each block reason — see README "Confirmation copy". */
export const MERGE_BLOCK_REASON_LABELS: Record<MergeBlockReason, string> = {
  same_item: "These are the same item.",
  type_mismatch: "These items are different types and can't be merged.",
  numbering_mode_conflict:
    "One item tracks absolute episode numbers and the other tracks season + episode. Markly can't safely tell which is farther along — change one item's numbering to match before merging.",
  progress_unit_conflict:
    "One item tracks progress by a different unit (chapter, page, or percent) than the other. Markly can't safely compare them — change one item's progress unit to match before merging.",
  catalog_source_conflict:
    "These items are linked to different catalog entries (e.g. different AniList works). They may not actually be the same title — merging is blocked to avoid combining two different works.",
};

function firstNonEmpty(a: string | undefined, b: string | undefined): string | undefined {
  return a && a.trim() ? a : b;
}

function firstDefined<T>(a: T | undefined, b: T | undefined): T | undefined {
  return a !== undefined ? a : b;
}

/** Case-insensitive union + dedupe, preserving the first-seen casing and order (survivor's own entries first). Used for tags/genres/authors/catalogPlatforms — see README "Array-field merge policy". */
function unionDedupe(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
  if (!a && !b) return undefined;
  const seen = new Map<string, string>();
  [...(a ?? []), ...(b ?? [])].forEach((value) => {
    const key = value.trim().toLowerCase();
    if (key && !seen.has(key)) seen.set(key, value);
  });
  return Array.from(seen.values());
}

function mergeCatalogSource(
  survivor: MediaItem,
  duplicate: MediaItem,
): { status: "ok"; catalogSource: CatalogSourceReference | undefined } | { status: "blocked"; reason: "catalog_source_conflict" } {
  if (!survivor.catalogSource) return { status: "ok", catalogSource: duplicate.catalogSource };
  if (!duplicate.catalogSource) return { status: "ok", catalogSource: survivor.catalogSource };
  if (survivor.catalogSource.provider === duplicate.catalogSource.provider && survivor.catalogSource.externalId === duplicate.catalogSource.externalId) {
    return { status: "ok", catalogSource: survivor.catalogSource };
  }
  // Section 19C — both exist and conflict: never silently overwrite one
  // with the other. Stage 27 blocks rather than offering a separate
  // high-warning confirmation path.
  return { status: "blocked", reason: "catalog_source_conflict" };
}

interface EpisodeProgressFields {
  currentEpisode?: number;
  currentSeason?: number;
  episodeNumbering?: EpisodeNumbering;
}

/**
 * Section 15-17: absolute progress preserves the furthest (higher)
 * episode; seasonal progress compares (season, episode) lexicographically
 * (reusing Stage 25's own semantics, never raw episode number); a genuine
 * numbering-mode conflict (one absolute, one seasonal, BOTH with real
 * progress) blocks the merge rather than guessing a conversion.
 */
function mergeEpisodeProgress(
  survivor: AnimeItem | SeriesItem,
  duplicate: AnimeItem | SeriesItem,
): { status: "ok"; fields: EpisodeProgressFields } | { status: "blocked"; reason: "numbering_mode_conflict" } {
  if (duplicate.currentEpisode === undefined) {
    return { status: "ok", fields: { currentEpisode: survivor.currentEpisode, currentSeason: survivor.currentSeason, episodeNumbering: survivor.episodeNumbering } };
  }
  if (survivor.currentEpisode === undefined) {
    return { status: "ok", fields: { currentEpisode: duplicate.currentEpisode, currentSeason: duplicate.currentSeason, episodeNumbering: duplicate.episodeNumbering } };
  }

  const survivorMode: EpisodeNumbering = survivor.episodeNumbering === "seasonal" ? "seasonal" : "absolute";
  const duplicateMode: EpisodeNumbering = duplicate.episodeNumbering === "seasonal" ? "seasonal" : "absolute";
  if (survivorMode !== duplicateMode) {
    return { status: "blocked", reason: "numbering_mode_conflict" };
  }

  if (survivorMode === "absolute") {
    return { status: "ok", fields: { currentEpisode: Math.max(survivor.currentEpisode, duplicate.currentEpisode), currentSeason: undefined, episodeNumbering: undefined } };
  }

  const survivorSeason = survivor.currentSeason ?? 0;
  const duplicateSeason = duplicate.currentSeason ?? 0;
  const survivorWins = survivorSeason > duplicateSeason || (survivorSeason === duplicateSeason && survivor.currentEpisode >= duplicate.currentEpisode);
  return {
    status: "ok",
    fields: survivorWins
      ? { currentEpisode: survivor.currentEpisode, currentSeason: survivor.currentSeason, episodeNumbering: "seasonal" }
      : { currentEpisode: duplicate.currentEpisode, currentSeason: duplicate.currentSeason, episodeNumbering: "seasonal" },
  };
}

interface NovelProgressFields {
  progressValue?: number;
  progressUnit?: NovelProgressUnit;
}

function mergeNovelProgress(
  survivor: NovelItem,
  duplicate: NovelItem,
): { status: "ok"; fields: NovelProgressFields } | { status: "blocked"; reason: "progress_unit_conflict" } {
  if (duplicate.progressValue === undefined) return { status: "ok", fields: { progressValue: survivor.progressValue, progressUnit: survivor.progressUnit } };
  if (survivor.progressValue === undefined) return { status: "ok", fields: { progressValue: duplicate.progressValue, progressUnit: duplicate.progressUnit } };

  const survivorUnit = survivor.progressUnit ?? "chapter";
  const duplicateUnit = duplicate.progressUnit ?? "chapter";
  if (survivorUnit !== duplicateUnit) {
    return { status: "blocked", reason: "progress_unit_conflict" };
  }
  return { status: "ok", fields: { progressValue: Math.max(survivor.progressValue, duplicate.progressValue), progressUnit: survivorUnit } };
}

/** Section 14/15 (manga) / Section 14 analog (game playtime) — simple "never regress" numeric merge, undefined-safe. */
function mergeFurthest(survivor: number | undefined, duplicate: number | undefined): number | undefined {
  if (survivor === undefined) return duplicate;
  if (duplicate === undefined) return survivor;
  return Math.max(survivor, duplicate);
}

/**
 * Computes the survivor's post-merge field values. Never mutates either
 * input. Returns `{status: "blocked"}` instead of fabricating a value
 * whenever the two items disagree in a way Markly can't safely resolve
 * (Sections 17-19) — the caller must refuse to proceed in that case, never
 * silently fall back to one side.
 */
export function computeMergedLibraryItem(survivor: MediaItem, duplicate: MediaItem): MergeComputation {
  if (survivor.id === duplicate.id) return { status: "blocked", reason: "same_item" };
  if (survivor.type !== duplicate.type) return { status: "blocked", reason: "type_mismatch" };

  const catalogResult = mergeCatalogSource(survivor, duplicate);
  if (catalogResult.status === "blocked") return catalogResult;

  const base = {
    id: survivor.id,
    title: survivor.title,
    // Section 9 — scalar fields: survivor wins when non-empty, filled from
    // duplicate only when survivor's own value is empty/absent.
    description: firstNonEmpty(survivor.description, duplicate.description) ?? "",
    category: firstNonEmpty(survivor.category, duplicate.category) ?? "",
    tags: unionDedupe(survivor.tags, duplicate.tags) ?? [],
    // Section 11 — either copy being favorited keeps the merged item favorited.
    favorite: survivor.favorite || duplicate.favorite,
    // Section 25/26 — survivor's own creation date is never reset; a merge is a real modification, so updatedAt advances.
    createdAt: survivor.createdAt,
    updatedAt: new Date().toISOString(),
    imageUrl: firstNonEmpty(survivor.imageUrl, duplicate.imageUrl),
    sourceUrl: firstNonEmpty(survivor.sourceUrl, duplicate.sourceUrl),
    // Section 12 — survivor's status always wins; TrackingStatus is never actually unset on a MediaItem, so there's no "missing" case to fill.
    status: survivor.status,
    // Section 13 — never averaged.
    rating: firstDefined(survivor.rating, duplicate.rating),
    releaseYear: firstDefined(survivor.releaseYear, duplicate.releaseYear),
    catalogSource: catalogResult.catalogSource,
  };

  switch (survivor.type) {
    case "anime": {
      const duplicateAnime = duplicate as AnimeItem;
      const progress = mergeEpisodeProgress(survivor, duplicateAnime);
      if (progress.status === "blocked") return progress;
      return {
        status: "ok",
        merged: {
          ...base,
          type: "anime",
          totalEpisodes: firstDefined(survivor.totalEpisodes, duplicateAnime.totalEpisodes),
          genres: unionDedupe(survivor.genres, duplicateAnime.genres),
          studio: firstNonEmpty(survivor.studio, duplicateAnime.studio),
          ...progress.fields,
        },
      };
    }
    case "series": {
      const duplicateSeries = duplicate as SeriesItem;
      const progress = mergeEpisodeProgress(survivor, duplicateSeries);
      if (progress.status === "blocked") return progress;
      return {
        status: "ok",
        merged: {
          ...base,
          type: "series",
          totalEpisodes: firstDefined(survivor.totalEpisodes, duplicateSeries.totalEpisodes),
          genres: unionDedupe(survivor.genres, duplicateSeries.genres),
          ...progress.fields,
        },
      };
    }
    case "manga": {
      const duplicateManga = duplicate as Extract<MediaItem, { type: "manga" }>;
      return {
        status: "ok",
        merged: {
          ...base,
          type: "manga",
          currentChapter: mergeFurthest(survivor.currentChapter, duplicateManga.currentChapter),
          totalChapters: firstDefined(survivor.totalChapters, duplicateManga.totalChapters),
          genres: unionDedupe(survivor.genres, duplicateManga.genres),
          authors: unionDedupe(survivor.authors, duplicateManga.authors),
        },
      };
    }
    case "novel": {
      const duplicateNovel = duplicate as NovelItem;
      const progress = mergeNovelProgress(survivor, duplicateNovel);
      if (progress.status === "blocked") return progress;
      return {
        status: "ok",
        merged: {
          ...base,
          type: "novel",
          authors: unionDedupe(survivor.authors, duplicateNovel.authors),
          pageCount: firstDefined(survivor.pageCount, duplicateNovel.pageCount),
          readingFormat: firstDefined(survivor.readingFormat, duplicateNovel.readingFormat),
          ...progress.fields,
        },
      };
    }
    case "movie": {
      const duplicateMovie = duplicate as Extract<MediaItem, { type: "movie" }>;
      return { status: "ok", merged: { ...base, type: "movie", genres: unionDedupe(survivor.genres, duplicateMovie.genres) } };
    }
    case "game": {
      const duplicateGame = duplicate as Extract<MediaItem, { type: "game" }>;
      return {
        status: "ok",
        merged: {
          ...base,
          type: "game",
          platform: firstNonEmpty(survivor.platform, duplicateGame.platform),
          playtimeHours: mergeFurthest(survivor.playtimeHours, duplicateGame.playtimeHours),
          developer: firstNonEmpty(survivor.developer, duplicateGame.developer),
          publisher: firstNonEmpty(survivor.publisher, duplicateGame.publisher),
          catalogPlatforms: unionDedupe(survivor.catalogPlatforms, duplicateGame.catalogPlatforms),
        },
      };
    }
  }
}
