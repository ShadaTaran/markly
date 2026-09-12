import type {
  CatalogSourceReference,
  EpisodeNumbering,
  LibraryItemType,
  NovelProgressUnit,
  NovelReadingFormat,
  TrackingStatus,
} from "@/types/library-item";
import type { ProgressKind } from "@/types/activity";

/**
 * Stage 29 — the portable Markly backup format. This is a PUBLIC CONTRACT,
 * not a dump of internal rows: every field here is deliberately listed
 * (see README "Portable Backup, Export & Import" for the full rationale),
 * so an internal schema change never silently changes what a backup file
 * contains. Nothing here can ever carry a secret — there is no field for
 * one.
 *
 * Deliberately excluded (see the module doc comment in lib/backup/*):
 * extension device/pairing credentials, AniList/OAuth connection records,
 * `anilistSync` sync-baseline metadata, recovery actions, and every
 * `user_id`/ownership/RLS-internal field.
 *
 * TrackingSources (Stage 40 data-integrity correction) ARE now included —
 * see BackupTrackingSource below — because Stage 40 made them first-class
 * user-created state (manually linked URLs, manual labels, explicit
 * source configuration), not merely extension telemetry. This is an
 * additive, optional section: `data.trackingSources` may be entirely
 * absent (any backup written before this correction, or a local-mode
 * export — see lib/backup/export.ts), and the format was already designed
 * from BACKUP_VERSION 1 onward to treat a missing/absent data.* array as
 * "zero records of that kind" (see validateBackupObject's own
 * `Array.isArray(rawX) ? rawX : []` handling for libraryItems/collections/
 * activityEvents) — so no version bump is needed for this addition; see
 * lib/backup/validate.ts's own doc comment for the full compatibility
 * analysis.
 */

export const BACKUP_FORMAT = "markly-backup" as const;
export const BACKUP_VERSION = 1 as const;

/**
 * Identifies a record ONLY within this one backup file — never a database
 * primary key, and never assumed to be globally unique or reusable across
 * accounts/imports. Import always remaps these to freshly-created ids.
 */
export type BackupItemId = string;
export type BackupCollectionId = string;

export type BackupCatalogSource = CatalogSourceReference;

/** Every LibraryItem field that is genuinely portable user data — see types/library-item.ts for the authoritative field-by-field source. */
export interface BackupLibraryItem {
  backupItemId: BackupItemId;
  type: LibraryItemType;
  title: string;
  description: string;
  category: string;
  tags: string[];
  favorite: boolean;
  createdAt: string;
  updatedAt?: string;

  // WebsiteItem
  url?: string;

  // MediaLibraryItem
  imageUrl?: string;
  sourceUrl?: string;
  releaseYear?: number;
  catalogSource?: BackupCatalogSource;

  // TrackableLibraryItem
  status?: TrackingStatus;
  rating?: number;

  // EpisodeTrackedItem (anime/series)
  currentEpisode?: number;
  totalEpisodes?: number;
  episodeNumbering?: EpisodeNumbering;
  currentSeason?: number;
  genres?: string[];
  studio?: string; // anime only

  // MangaItem
  currentChapter?: number;
  totalChapters?: number;
  authors?: string[]; // manga, novel

  // NovelItem
  progressValue?: number;
  progressUnit?: NovelProgressUnit;
  pageCount?: number;
  readingFormat?: NovelReadingFormat;

  // GameItem
  platform?: string;
  playtimeHours?: number;
  developer?: string;
  publisher?: string;
  catalogPlatforms?: string[];
}

export interface BackupCollection {
  backupCollectionId: BackupCollectionId;
  name: string;
  description?: string;
  createdAt: string;
  /** References BackupLibraryItem.backupItemId — never a database id. */
  itemIds: BackupItemId[];
}

/** Mirrors ActivityEvent's discriminated union exactly, minus its own `id` (purely internal, not preserved across a backup) and with `itemId` repurposed to a backup-local id. Kept as a real discriminated union (not a flattened interface) because `previousValue`/`newValue` have different types per variant — numeric for progress/rating, TrackingStatus for status. */
interface BackupBaseActivityEvent {
  itemId: BackupItemId;
  timestamp: string;
}
export interface BackupProgressActivityEvent extends BackupBaseActivityEvent {
  type: "progress_updated";
  progressKind: ProgressKind;
  previousValue?: number;
  newValue: number;
  previousSeason?: number;
  newSeason?: number;
}
export interface BackupRatingActivityEvent extends BackupBaseActivityEvent {
  type: "rating_updated";
  previousValue?: number;
  newValue?: number;
}
export interface BackupStatusActivityEvent extends BackupBaseActivityEvent {
  type: "status_updated";
  previousValue?: TrackingStatus;
  newValue: TrackingStatus;
}
export interface BackupItemAddedActivityEvent extends BackupBaseActivityEvent {
  type: "item_added";
}
export type BackupActivityEvent =
  | BackupProgressActivityEvent
  | BackupRatingActivityEvent
  | BackupStatusActivityEvent
  | BackupItemAddedActivityEvent;

/**
 * Stage 40 data-integrity correction — one user-managed TrackingSource
 * link. Only sources actually LINKED to a LibraryItem at export time are
 * ever included (see lib/cloud/backup.ts's fetch query) — an unlinked,
 * never-acted-upon extension detection isn't user-created library state
 * the way a deliberate link is, and has no `backupItemId` to attach to
 * anyway.
 *
 * Field-by-field rationale (see the Stage 40 correction's own audit):
 *   - `adapterId` + `sourceKey` are preserved EXACTLY as stored, for every
 *     source regardless of origin (manual or extension-detected) — one
 *     uniform model, never two incompatible ones. This is what lets a
 *     restored extension-detected source still be recognized correctly by
 *     a later real detection from that same adapter (same identity pair),
 *     and lets a restored manual source keep working with createManualSource's
 *     own "manual"-adapter identity unchanged.
 *   - `mediaType` is deliberately NOT exported: restore always re-derives
 *     it from the restored parent LibraryItem's own real, current type
 *     (see restoreTrackingSource) — the exact same "server truth over a
 *     declared value" principle the Stage 40 correction applied to the
 *     live Add Source route, applied consistently here too.
 *   - `lastDetectedProgress` is deliberately NOT exported: it is
 *     extension-observed telemetry, not user-created data, and the
 *     authoritative progress already lives on the LibraryItem itself
 *     (already exported/restored via BackupLibraryItem's own progress
 *     fields) — re-detection will refresh it naturally if that source is
 *     ever visited again.
 *   - `lastSeenAt` IS exported (unlike created_at/updated_at, which
 *     nothing reads): lib/dashboard.ts's selectBestTrackingSource orders
 *     candidates by it, so dropping it would silently change which source
 *     a restored item resumes to.
 *   - `suppressed` (derived from auto_link_suppressed_at !== null) is
 *     exported so a restore can never silently resurrect automatic
 *     tracking for a source the user explicitly rejected — see
 *     restoreTrackingSource's own doc comment for exactly when it is and
 *     isn't reapplied.
 *   - `id`, `user_id`, `library_item_id` (the raw database id — replaced
 *     by `backupItemId`), and every RLS-internal field are excluded, same
 *     as every other backup record type.
 */
export interface BackupTrackingSource {
  /** References BackupLibraryItem.backupItemId — never a database id. */
  backupItemId: BackupItemId;
  adapterId: string;
  sourceKey: string;
  sourceTitle: string;
  sourceUrl: string;
  autoTrackEnabled: boolean;
  suppressed: boolean;
  lastSeenAt: string;
}

export interface BackupData {
  libraryItems: BackupLibraryItem[];
  collections: BackupCollection[];
  activityEvents: BackupActivityEvent[];
  /** Optional — see the module doc comment above. Absent in any pre-Stage-40 backup and in every local-mode export (tracking_sources has no local/signed-out equivalent — see lib/backup/export.ts). */
  trackingSources?: BackupTrackingSource[];
}

/** The full file contract. `backupId` identifies this one export instance (for display/debugging only — see README for why it is never used as the sole duplicate-prevention mechanism); it is never treated as proof of prior-import history. */
export interface MarklyBackupV1 {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  exportedAt: string;
  backupId: string;
  data: BackupData;
}
