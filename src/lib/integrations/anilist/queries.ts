export const VIEWER_QUERY = `
  query {
    Viewer {
      id
      name
    }
  }
`;

export interface AniListViewer {
  id: number;
  name: string;
}

export interface AniListViewerResponse {
  Viewer: AniListViewer | null;
}

/**
 * One combined request for both Anime and Manga lists (aliased), rather
 * than two — and MediaListCollection itself returns the user's entire
 * collection unpaginated, so a full import/sync is exactly one GraphQL
 * request regardless of library size. score(format: POINT_10_DECIMAL)
 * forces AniList to normalize the personal score to a 0-10 float
 * regardless of the account's configured scoreFormat, so Markly never
 * needs to branch on POINT_100/POINT_5/POINT_3 — see anilist/mapping.ts.
 */
export const MEDIA_LISTS_QUERY = `
  query ($userId: Int) {
    anime: MediaListCollection(userId: $userId, type: ANIME) {
      lists {
        entries {
          status
          score(format: POINT_10_DECIMAL)
          progress
          updatedAt
          media {
            id
            title { english romaji }
            description(asHtml: false)
            coverImage { large medium }
            startDate { year }
            episodes
            genres
            studios(isMain: true) { nodes { name } }
          }
        }
      }
    }
    manga: MediaListCollection(userId: $userId, type: MANGA) {
      lists {
        entries {
          status
          score(format: POINT_10_DECIMAL)
          progress
          updatedAt
          media {
            id
            title { english romaji }
            description(asHtml: false)
            coverImage { large medium }
            startDate { year }
            chapters
            genres
            staff(sort: RELEVANCE, perPage: 2) { nodes { name { full } } }
          }
        }
      }
    }
  }
`;

export interface AniListMediaTitle {
  english: string | null;
  romaji: string | null;
}

export interface AniListMediaCommon {
  id: number;
  title: AniListMediaTitle;
  description: string | null;
  coverImage: { large: string | null; medium: string | null } | null;
  startDate: { year: number | null } | null;
  genres: string[] | null;
}

export interface AniListAnimeMedia extends AniListMediaCommon {
  episodes: number | null;
  studios: { nodes: { name: string }[] } | null;
}

export interface AniListMangaMedia extends AniListMediaCommon {
  chapters: number | null;
  staff: { nodes: { name: { full: string | null } }[] } | null;
}

export interface AniListListEntry<TMedia> {
  status: string;
  score: number | null;
  progress: number | null;
  updatedAt: number | null;
  media: TMedia;
}

export interface AniListMediaListsResponse {
  anime: { lists: { entries: AniListListEntry<AniListAnimeMedia>[] }[] } | null;
  manga: { lists: { entries: AniListListEntry<AniListMangaMedia>[] }[] } | null;
}

export function flattenEntries<TMedia>(collection: { lists: { entries: AniListListEntry<TMedia>[] }[] } | null): AniListListEntry<TMedia>[] {
  if (!collection) return [];
  return collection.lists.flatMap((list) => list.entries);
}
