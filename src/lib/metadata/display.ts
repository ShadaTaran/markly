import type { MediaItem } from "@/types/library-item";

export interface CatalogDisplaySource {
  title: string;
  imageUrl?: string;
  genres?: string[];
  year?: number;
  totalEpisodes?: number;
  totalChapters?: number;
  catalogPlatforms?: string[];
}

export interface CatalogDisplay {
  title: string;
  imageUrl?: string;
  genresLine?: string;
  metaLine?: string;
}

/** Builds the two read-only summary lines shown above the compact tracking form. */
export function buildCatalogDisplay(type: MediaItem["type"], source: CatalogDisplaySource): CatalogDisplay {
  const genresLine = source.genres && source.genres.length > 0 ? source.genres.join(" • ") : undefined;

  const metaParts: string[] = [];
  if (type === "manga" && source.totalChapters !== undefined) {
    metaParts.push(`${source.totalChapters} chapters`);
  }
  if ((type === "anime" || type === "series") && source.totalEpisodes !== undefined) {
    metaParts.push(`${source.totalEpisodes} episodes`);
  }
  if (type === "game" && source.catalogPlatforms && source.catalogPlatforms.length > 0) {
    metaParts.push(source.catalogPlatforms.join(", "));
  }
  if (source.year !== undefined) metaParts.push(String(source.year));

  return {
    title: source.title,
    imageUrl: source.imageUrl,
    genresLine,
    metaLine: metaParts.length > 0 ? metaParts.join(" • ") : undefined,
  };
}
