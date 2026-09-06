export const VIEWER_QUERY = `
  query {
    Viewer {
      id
      name
      mediaListOptions {
        scoreFormat
      }
    }
  }
`;

export interface AniListViewer {
  id: number;
  name: string;
  /** Absent only if AniList's response is ever missing this object — falls back to POINT_10_DECIMAL (Markly's own most-precise native equivalent) at the call site, never assumed silently mid-conversion. */
  mediaListOptions: { scoreFormat: string } | null;
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

/**
 * Stage 30 — single list-entry lookup, confirmed via GraphQL
 * introspection: `MediaList(userId: Int, mediaId: Int)` exists on the
 * live schema and returns one entry (or null if the user has no entry
 * for that media). Used both to build the reconciliation preview's
 * per-item remote snapshot and, critically, to re-fetch the CURRENT
 * remote state immediately before every outbound mutation (staleness
 * check — see writeback.ts). `id` (the AniList list-entry's own id) is
 * requested so an update can target it directly via
 * SaveMediaListEntry's own `id` argument, rather than relying on
 * mediaId-only upsert semantics.
 */
export const MEDIA_LIST_ENTRY_QUERY = `
  query ($userId: Int, $mediaId: Int) {
    MediaList(userId: $userId, mediaId: $mediaId) {
      id
      status
      score(format: POINT_10_DECIMAL)
      progress
      updatedAt
      media {
        id
      }
    }
  }
`;

/** A single list-entry, including its own AniList-assigned id (never present on the bulk MediaListCollection entries AniListListEntry models — those are never targeted individually). */
export interface AniListMediaListEntry {
  id: number;
  status: string;
  score: number | null;
  progress: number | null;
  updatedAt: number | null;
  media: { id: number };
}

export interface AniListMediaListEntryResponse {
  MediaList: AniListMediaListEntry | null;
}

/**
 * Stage 30 — outbound write. Confirmed via GraphQL introspection against
 * the live schema (not scraped docs): SaveMediaListEntry accepts `id`
 * (targets an existing entry for update — omit to create a new one),
 * `mediaId` (required), `status: MediaListStatus`, `score: Float` (the
 * user's own scoreFormat scale), `scoreRaw: Int` (always 0-100,
 * format-independent — see anilist/score.ts), and `progress: Int`. This
 * migration intentionally sends ONLY these fields (Stage 30's narrow v1
 * outbound surface — never notes, custom lists, repeat counts,
 * priority, private flag, or dates, none of which Stage 30 manages).
 */
export const SAVE_MEDIA_LIST_ENTRY_MUTATION = `
  mutation ($id: Int, $mediaId: Int, $status: MediaListStatus, $score: Float, $scoreRaw: Int, $progress: Int) {
    SaveMediaListEntry(id: $id, mediaId: $mediaId, status: $status, score: $score, scoreRaw: $scoreRaw, progress: $progress) {
      id
      status
      score(format: POINT_10_DECIMAL)
      progress
      updatedAt
      media {
        id
      }
    }
  }
`;

export interface SaveMediaListEntryVariables {
  id?: number;
  mediaId: number;
  status?: string;
  score?: number;
  scoreRaw?: number;
  progress?: number;
}

export interface AniListSaveMediaListEntryResponse {
  SaveMediaListEntry: AniListMediaListEntry | null;
}
