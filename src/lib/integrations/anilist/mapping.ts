import type { TrackingStatus } from "@/types/library-item";
import type { MetadataDetails } from "@/lib/metadata/types";
import { normalizeDescription, normalizeStringArray } from "@/lib/metadata/sanitize";
import { normalizeRating } from "@/lib/tracking";
import type { AniListAnimeMedia, AniListMangaMedia } from "@/lib/integrations/anilist/queries";

/**
 * The subset of AniListListEntry<TMedia> that status/score/progress/baseline
 * logic actually needs. Any concrete AniListListEntry<AniListAnimeMedia |
 * AniListMangaMedia> is structurally assignable here — no cast required —
 * so this module never needs to know which media type it's handling.
 */
export interface AniListEntryFields {
  status: string;
  score: number | null;
  progress: number | null;
  updatedAt: number | null;
  media: { id: number };
}

/**
 * AniList MediaListStatus → Markly TrackingStatus.
 *
 * REPEATING has no Markly-native equivalent (Markly's status model has no
 * "rewatching" state, and Stage 17 intentionally doesn't add one — see
 * README). It maps to in_progress, same as CURRENT, but `wasRepeating` is
 * returned alongside so callers can record that provenance in the
 * per-item AniList sync baseline (metadata.anilistSync) without it ever
 * becoming a real Markly status value.
 */
export function mapAniListStatus(status: string): { markly: TrackingStatus; wasRepeating: boolean } {
  switch (status) {
    case "CURRENT":
      return { markly: "in_progress", wasRepeating: false };
    case "PLANNING":
      return { markly: "planned", wasRepeating: false };
    case "COMPLETED":
      return { markly: "completed", wasRepeating: false };
    case "DROPPED":
      return { markly: "dropped", wasRepeating: false };
    case "PAUSED":
      return { markly: "on_hold", wasRepeating: false };
    case "REPEATING":
      return { markly: "in_progress", wasRepeating: true };
    default:
      return { markly: "planned", wasRepeating: false };
  }
}

/**
 * AniList's personal score is requested as score(format: POINT_10_DECIMAL)
 * — a 0-10 float regardless of the account's configured scoreFormat — so
 * no POINT_100/POINT_5/POINT_3 branching is needed here. 0 (or absent)
 * means "no score" on AniList and maps to Markly's "unrated" (undefined),
 * never to a literal 0 rating. normalizeRating rounds to Markly's 0.5-step
 * model, which loses AniList's 0.1 precision (e.g. 7.3 → 7.5) — documented
 * in README as a deliberate, acceptable simplification.
 */
export function mapAniListScore(score: number | null | undefined): number | undefined {
  if (score === null || score === undefined || score <= 0) return undefined;
  return normalizeRating(score);
}

function mediaTitle(title: { english: string | null; romaji: string | null }): string {
  return title.english || title.romaji || "Untitled";
}

export function mapAnimeMediaToCatalog(media: AniListAnimeMedia): MetadataDetails {
  return {
    provider: "anilist",
    externalId: String(media.id),
    title: mediaTitle(media.title),
    imageUrl: media.coverImage?.large ?? media.coverImage?.medium ?? undefined,
    year: media.startDate?.year ?? undefined,
    description: media.description ? normalizeDescription(media.description) : undefined,
    genres: normalizeStringArray(media.genres),
    totalEpisodes: media.episodes ?? undefined,
    studio: media.studios?.nodes[0]?.name,
  };
}

export function mapMangaMediaToCatalog(media: AniListMangaMedia): MetadataDetails {
  const staffNames = normalizeStringArray(media.staff?.nodes.map((node) => node.name.full ?? ""));
  return {
    provider: "anilist",
    externalId: String(media.id),
    title: mediaTitle(media.title),
    imageUrl: media.coverImage?.large ?? media.coverImage?.medium ?? undefined,
    year: media.startDate?.year ?? undefined,
    description: media.description ? normalizeDescription(media.description) : undefined,
    genres: normalizeStringArray(media.genres),
    totalChapters: media.chapters ?? undefined,
    authors: staffNames,
  };
}

/** The three personal fields Stage 17 ever reads from or writes to Markly — never catalog data, collections, or favorites. */
export interface AniListPersonalTracking {
  status: TrackingStatus;
  progress: number;
  rating: number | undefined;
}

export function mapEntryToPersonalTracking(entry: AniListEntryFields): AniListPersonalTracking {
  const { markly } = mapAniListStatus(entry.status);
  return {
    status: markly,
    progress: entry.progress ?? 0,
    rating: mapAniListScore(entry.score),
  };
}

/**
 * Snapshot of AniList's state as of the last successful sync, stored in
 * the item's own metadata JSONB (library_items.metadata.anilistSync) —
 * not a separate table. This is what later Sync Now calls compare against
 * to tell "AniList changed" from "Markly changed" from "both changed"
 * (see anilist/sync.ts) rather than guessing from timestamps alone.
 */
export interface AniListSyncBaseline {
  mediaId: string;
  status: string;
  wasRepeating: boolean;
  progress: number;
  score: number | null;
  anilistUpdatedAt: number | null;
  syncedAt: string;
}

export function buildSyncBaseline(entry: AniListEntryFields, syncedAt: string): AniListSyncBaseline {
  return {
    mediaId: String(entry.media.id),
    status: entry.status,
    wasRepeating: entry.status === "REPEATING",
    progress: entry.progress ?? 0,
    score: entry.score,
    anilistUpdatedAt: entry.updatedAt,
    syncedAt,
  };
}

export function readSyncBaseline(metadata: Record<string, unknown>): AniListSyncBaseline | undefined {
  const raw = metadata.anilistSync;
  if (!raw || typeof raw !== "object") return undefined;
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.mediaId !== "string" || typeof candidate.status !== "string") return undefined;
  return {
    mediaId: candidate.mediaId,
    status: candidate.status,
    wasRepeating: candidate.wasRepeating === true,
    progress: typeof candidate.progress === "number" ? candidate.progress : 0,
    score: typeof candidate.score === "number" ? candidate.score : null,
    anilistUpdatedAt: typeof candidate.anilistUpdatedAt === "number" ? candidate.anilistUpdatedAt : null,
    syncedAt: typeof candidate.syncedAt === "string" ? candidate.syncedAt : new Date(0).toISOString(),
  };
}
