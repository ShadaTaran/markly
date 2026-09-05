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
 * TrackingSources, extension device/pairing credentials, AniList/OAuth
 * connection records, `anilistSync` sync-baseline metadata, recovery
 * actions, and every `user_id`/ownership/RLS-internal field.
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

export interface BackupData {
  libraryItems: BackupLibraryItem[];
  collections: BackupCollection[];
  activityEvents: BackupActivityEvent[];
}

/** The full file contract. `backupId` identifies this one export instance (for display/debugging only — see README for why it is never used as the sole duplicate-prevention mechanism); it is never treated as proof of prior-import history. */
export interface MarklyBackupV1 {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  exportedAt: string;
  backupId: string;
  data: BackupData;
}
