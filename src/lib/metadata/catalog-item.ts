import type { MediaItem, MediaItemInput } from "@/types/library-item";
import type { MetadataDetails } from "@/lib/metadata/types";
import { buildCatalogDisplay, type CatalogDisplay } from "@/lib/metadata/display";
import { deriveCategoryAndTags } from "@/lib/metadata/derive";
import type { PersonalTrackingValues } from "@/components/CatalogTrackingForm";

/** True for any saved media item that was created from a catalog search selection. */
export function hasCatalogSource(item: MediaItem): boolean {
  return item.catalogSource !== undefined;
}

export function buildCatalogDisplayFromPrefill(type: MediaItem["type"], prefill: MetadataDetails): CatalogDisplay {
  return buildCatalogDisplay(type, {
    title: prefill.title,
    imageUrl: prefill.imageUrl,
    genres: prefill.genres,
    year: prefill.year,
    totalEpisodes: prefill.totalEpisodes,
    totalChapters: prefill.totalChapters,
    catalogPlatforms: prefill.catalogPlatforms,
  });
}

export function buildCatalogDisplayFromItem(item: MediaItem): CatalogDisplay {
  return buildCatalogDisplay(item.type, {
    title: item.title,
    imageUrl: item.imageUrl,
    genres: "genres" in item ? item.genres : undefined,
    year: item.releaseYear,
    totalEpisodes: "totalEpisodes" in item ? item.totalEpisodes : undefined,
    totalChapters: "totalChapters" in item ? item.totalChapters : undefined,
    catalogPlatforms: "catalogPlatforms" in item ? item.catalogPlatforms : undefined,
  });
}

/** Catalog totals used only for the compact form's "can't exceed total" validation. */
export function getCatalogTotals(item: MediaItem): { totalEpisodes?: number; totalChapters?: number } {
  return {
    totalEpisodes: "totalEpisodes" in item ? item.totalEpisodes : undefined,
    totalChapters: "totalChapters" in item ? item.totalChapters : undefined,
  };
}

export function buildInitialTrackingFromItem(item: MediaItem): PersonalTrackingValues {
  return {
    status: item.status,
    rating: item.rating,
    currentEpisode: "currentEpisode" in item ? item.currentEpisode : undefined,
    currentChapter: "currentChapter" in item ? item.currentChapter : undefined,
    progressValue: "progressValue" in item ? item.progressValue : undefined,
    progressUnit: "progressUnit" in item ? item.progressUnit : undefined,
    playtimeHours: "playtimeHours" in item ? item.playtimeHours : undefined,
  };
}

/**
 * Builds a brand-new catalog-backed item's full input: catalog facts come
 * from the search selection untouched (title/description/cover/genres/
 * release info/provider reference/etc.), category and tags are derived
 * from genres, and the only user-provided values are progress/rating
 * (status is inferred by the caller before this runs).
 */
export function buildCatalogMediaInput(
  type: MediaItem["type"],
  catalogData: MetadataDetails,
  personal: PersonalTrackingValues,
): MediaItemInput {
  const { category, tags } = deriveCategoryAndTags(catalogData.genres);

  const common = {
    title: catalogData.title,
    description: catalogData.description ?? "",
    category,
    tags,
    imageUrl: catalogData.imageUrl,
    sourceUrl: undefined,
    status: personal.status,
    rating: personal.rating,
    releaseYear: catalogData.year,
    catalogSource: { provider: catalogData.provider, externalId: catalogData.externalId },
  };

  switch (type) {
    case "anime":
      return {
        ...common,
        currentEpisode: personal.currentEpisode,
        totalEpisodes: catalogData.totalEpisodes,
        genres: catalogData.genres,
        studio: catalogData.studio,
      };
    case "series":
      return {
        ...common,
        currentEpisode: personal.currentEpisode,
        totalEpisodes: catalogData.totalEpisodes,
        genres: catalogData.genres,
      };
    case "manga":
      return {
        ...common,
        currentChapter: personal.currentChapter,
        totalChapters: catalogData.totalChapters,
        genres: catalogData.genres,
        authors: catalogData.authors,
      };
    case "novel":
      return {
        ...common,
        progressValue: personal.progressValue,
        progressUnit: personal.progressUnit,
        authors: catalogData.authors,
        pageCount: catalogData.pageCount,
      };
    case "movie":
      return { ...common, genres: catalogData.genres };
    case "game":
      return {
        ...common,
        playtimeHours: personal.playtimeHours,
        developer: catalogData.developer,
        publisher: catalogData.publisher,
        catalogPlatforms: catalogData.catalogPlatforms,
      };
  }
}

/**
 * Builds the update input for the compact edit form: only status, rating,
 * and the one relevant progress field change. Title/description/category/
 * tags/imageUrl/sourceUrl pass through unchanged (updateMediaItem doesn't
 * touch genres/releaseYear/catalogSource/authors/developer/publisher/
 * catalogPlatforms at all, so those survive regardless via its own spread).
 */
export function buildPersonalOnlyMediaInput(item: MediaItem, personal: PersonalTrackingValues): MediaItemInput {
  const common = {
    title: item.title,
    description: item.description,
    category: item.category,
    tags: item.tags,
    imageUrl: item.imageUrl,
    sourceUrl: item.sourceUrl,
    status: personal.status,
    rating: personal.rating,
  };

  switch (item.type) {
    case "anime":
    case "series":
      return { ...common, currentEpisode: personal.currentEpisode, totalEpisodes: item.totalEpisodes };
    case "manga":
      return { ...common, currentChapter: personal.currentChapter, totalChapters: item.totalChapters };
    case "novel":
      return {
        ...common,
        progressValue: personal.progressValue,
        progressUnit: personal.progressUnit,
        authors: item.authors,
      };
    case "movie":
      return { ...common };
    case "game":
      return { ...common, playtimeHours: personal.playtimeHours, platform: item.platform };
  }
}
