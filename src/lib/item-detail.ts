import type {
  LibraryItem,
  LibraryItemType,
  MediaItem,
  MetadataProvider,
  SupportedItemType,
  WebsiteItem,
} from "@/types/library-item";
import { SUPPORTED_ITEM_TYPES } from "@/types/library-item";

export interface MetadataRow {
  label: string;
  value: string;
}

/**
 * True for the six real, trackable media types. Excluding "website" alone
 * doesn't fully narrow LibraryItem to MediaItem — the generic placeholder
 * type (article/video/other) is also part of the union — so this checks
 * every non-media type explicitly instead of relying on a single negation.
 */
export function isMediaItem(item: LibraryItem): item is MediaItem {
  return (
    item.type !== "website" &&
    item.type !== "article" &&
    item.type !== "video" &&
    item.type !== "other"
  );
}

/** True for the 7 types that actually have a form/card today (excludes the unused generic placeholder types). */
export function isSupportedItemType(type: LibraryItemType): type is SupportedItemType {
  return (SUPPORTED_ITEM_TYPES as readonly LibraryItemType[]).includes(type);
}

/**
 * Narrows the item itself (not just its `.type` field) down to the shape
 * LibraryItemDialog's edit state expects — WebsiteItem | MediaItem, i.e.
 * everything except the unused generic placeholder types.
 */
export function isSupportedLibraryItem(item: LibraryItem): item is WebsiteItem | MediaItem {
  return isSupportedItemType(item.type);
}

/**
 * Type-specific catalog metadata rows for the detail page, in display
 * order. Only ever includes fields that are actually present — nothing
 * here ever renders "undefined"/"null"/a misleading "0".
 */
export function getCatalogMetadataRows(item: MediaItem): MetadataRow[] {
  const rows: MetadataRow[] = [];

  if (item.releaseYear) rows.push({ label: "Release Year", value: String(item.releaseYear) });

  switch (item.type) {
    case "anime":
      if (item.studio) rows.push({ label: "Studio", value: item.studio });
      break;
    case "manga":
      if (item.authors && item.authors.length > 0) {
        rows.push({ label: "Author(s)", value: item.authors.join(", ") });
      }
      break;
    case "novel":
      if (item.authors && item.authors.length > 0) {
        rows.push({ label: "Author(s)", value: item.authors.join(", ") });
      }
      if (item.pageCount) rows.push({ label: "Pages", value: String(item.pageCount) });
      break;
    case "game":
      if (item.developer) rows.push({ label: "Developer", value: item.developer });
      if (item.publisher) rows.push({ label: "Publisher", value: item.publisher });
      if (item.catalogPlatforms && item.catalogPlatforms.length > 0) {
        rows.push({ label: "Platforms", value: item.catalogPlatforms.join(", ") });
      }
      break;
    case "movie":
    case "series":
      break;
  }

  return rows;
}

const PROVIDER_LABELS: Record<MetadataProvider, string> = {
  anilist: "AniList",
  "open-library": "Open Library",
  tmdb: "TMDB",
  rawg: "RAWG",
};

export function getProviderLabel(provider: MetadataProvider): string {
  return PROVIDER_LABELS[provider];
}

const DATE_FORMATTER = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "long", day: "numeric" });

/** Formats an ISO timestamp for display; returns undefined for anything unparseable. */
export function formatDate(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? undefined : DATE_FORMATTER.format(date);
}

export function getItemHref(item: LibraryItem): string {
  return `/library/${item.id}`;
}
