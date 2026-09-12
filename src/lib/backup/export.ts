import type { ActivityEvent } from "@/types/activity";
import type { Collection } from "@/types/collection";
import type { LibraryItem, MediaItem } from "@/types/library-item";
import type { BackupActivityEvent, BackupCollection, BackupLibraryItem, BackupTrackingSource, MarklyBackupV1 } from "@/types/backup";
import { BACKUP_FORMAT, BACKUP_VERSION } from "@/types/backup";
import type { ExportableTrackingSource } from "@/lib/cloud/backup";
import { isMediaItem } from "@/lib/item-detail";
import { generateId } from "@/lib/utils";
import { isValidMarklyBackup } from "@/lib/backup/validate";

/**
 * Stage 29 — builds the portable backup object from already-typed app
 * data. Deliberately mode-agnostic: local mode's `library.items`/
 * `collectionsStore.collections`/`activity.events` and cloud mode's
 * equivalents are the exact same shapes, so this one function serves
 * both — only how the caller OBTAINS complete data differs (see
 * lib/cloud/backup.ts's doc comment for why cloud mode can't just reuse
 * the app's already-loaded Activity state).
 *
 * A LibraryItem's own `id` is reused directly as its `backupItemId` — safe
 * because backup ids are scoped to this file only (see types/backup.ts);
 * it is never treated as proof of identity on import, which always
 * remaps to freshly-created ids regardless.
 *
 * `trackingSources` (Stage 40 data-integrity correction) is optional and
 * defaults to `[]` — local mode always calls this with nothing (tracking_
 * sources has no local/signed-out representation; see BackupSettingsPanel),
 * while cloud mode passes rows already fetched via `fetchTrackingSourcesForExport`.
 * Each row's `library_item_id` is reused directly as its `backupItemId`,
 * exactly like LibraryItem's own id above — the fetch already scoped this
 * to rows that ARE linked to one.
 *
 * Export consistency: cloud mode fetches items/collections/activity as
 * three independent queries (see lib/cloud/backup.ts), not one
 * transactional snapshot. Considered and rejected building a server-side
 * snapshot RPC for this: the only way read-time drift (e.g. a browser
 * tracking commit landing mid-export) could matter is a relationship
 * pointing at a row the other query didn't happen to include yet — and
 * validateBackupObject already drops exactly that class of dangling
 * reference safely on import (Section 61 of the spec: "relationship to
 * missing backup item"), the same tolerance a normal hand-edited or
 * slightly-stale file would need anyway. A momentary miss just means one
 * relationship doesn't round-trip this one time, never a crash, never
 * corruption, never a wrong-owner write. That's an acceptable trade-off
 * for avoiding SQL that isn't otherwise needed.
 */
export function buildBackup(
  items: LibraryItem[],
  collections: Collection[],
  events: ActivityEvent[],
  trackingSourceRows: ExportableTrackingSource[] = [],
): MarklyBackupV1 {
  const libraryItems: BackupLibraryItem[] = items.map(toBackupLibraryItem);
  const backupCollections: BackupCollection[] = collections.map((collection) => ({
    backupCollectionId: collection.id,
    name: collection.name,
    description: collection.description,
    createdAt: collection.createdAt,
    itemIds: collection.itemIds,
  }));
  const activityEvents: BackupActivityEvent[] = events.map(toBackupActivityEvent);
  // A row with no source_url at all (possible for some extension
  // detections — see ExportableTrackingSource's own doc comment) has
  // nothing left worth restoring, matching validateTrackingSource's own
  // reasoning for dropping such a record — filtered out here rather than
  // exported as a phantom empty-URL record that would just get silently
  // dropped again on the next import anyway.
  const trackingSources: BackupTrackingSource[] = trackingSourceRows.filter((row) => row.source_url).map(toBackupTrackingSource);

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    backupId: generateId(),
    data: { libraryItems, collections: backupCollections, activityEvents, trackingSources },
  };
}

function toBackupTrackingSource(row: ExportableTrackingSource): BackupTrackingSource {
  return {
    backupItemId: row.library_item_id,
    adapterId: row.adapter_id,
    sourceKey: row.source_key,
    sourceTitle: row.source_title,
    sourceUrl: row.source_url ?? "",
    autoTrackEnabled: row.auto_track_enabled,
    suppressed: row.auto_link_suppressed_at !== null,
    lastSeenAt: row.last_seen_at,
  };
}

function toBackupLibraryItem(item: LibraryItem): BackupLibraryItem {
  const base: BackupLibraryItem = {
    backupItemId: item.id,
    type: item.type,
    title: item.title,
    description: item.description,
    category: item.category,
    tags: item.tags,
    favorite: item.favorite,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };

  if (item.type === "website") {
    return { ...base, url: item.url };
  }
  if (!isMediaItem(item)) {
    // Generic placeholder type (article/video/other) — never actually
    // created by the app (no form for it exists), but handled here for
    // completeness rather than silently dropped: only the base fields
    // apply, matching its own shape.
    return base;
  }

  const media: BackupLibraryItem = {
    ...base,
    imageUrl: item.imageUrl,
    sourceUrl: item.sourceUrl,
    releaseYear: item.releaseYear,
    catalogSource: item.catalogSource,
    status: item.status,
    rating: item.rating,
  };

  return applyMediaFields(media, item);
}

function applyMediaFields(media: BackupLibraryItem, item: MediaItem): BackupLibraryItem {
  switch (item.type) {
    case "anime":
      return {
        ...media,
        currentEpisode: item.currentEpisode,
        totalEpisodes: item.totalEpisodes,
        episodeNumbering: item.episodeNumbering,
        currentSeason: item.currentSeason,
        genres: item.genres,
        studio: item.studio,
      };
    case "series":
      return {
        ...media,
        currentEpisode: item.currentEpisode,
        totalEpisodes: item.totalEpisodes,
        episodeNumbering: item.episodeNumbering,
        currentSeason: item.currentSeason,
        genres: item.genres,
      };
    case "manga":
      return { ...media, currentChapter: item.currentChapter, totalChapters: item.totalChapters, genres: item.genres, authors: item.authors };
    case "novel":
      return {
        ...media,
        progressValue: item.progressValue,
        progressUnit: item.progressUnit,
        authors: item.authors,
        pageCount: item.pageCount,
        readingFormat: item.readingFormat,
      };
    case "movie":
      return { ...media, genres: item.genres };
    case "game":
      return {
        ...media,
        platform: item.platform,
        playtimeHours: item.playtimeHours,
        developer: item.developer,
        publisher: item.publisher,
        catalogPlatforms: item.catalogPlatforms,
      };
  }
}

function toBackupActivityEvent(event: ActivityEvent): BackupActivityEvent {
  switch (event.type) {
    case "progress_updated":
      return {
        itemId: event.itemId,
        type: "progress_updated",
        timestamp: event.timestamp,
        progressKind: event.progressKind,
        previousValue: event.previousValue,
        newValue: event.newValue,
        previousSeason: event.previousSeason,
        newSeason: event.newSeason,
      };
    case "rating_updated":
      return { itemId: event.itemId, type: "rating_updated", timestamp: event.timestamp, previousValue: event.previousValue, newValue: event.newValue };
    case "status_updated":
      return { itemId: event.itemId, type: "status_updated", timestamp: event.timestamp, previousValue: event.previousValue, newValue: event.newValue };
    case "item_added":
      return { itemId: event.itemId, type: "item_added", timestamp: event.timestamp };
  }
}

export interface BuildAndValidateResult {
  ok: boolean;
  backup?: MarklyBackupV1;
}

/**
 * Runs the freshly-built backup through the SAME validator import uses
 * before ever offering it for download (Section 15 of the Stage 29 spec:
 * "Never produce a backup Markly itself considers invalid"). This can
 * only fail if export and validate drift out of sync with each other —
 * a real bug, not a data problem — so the caller should treat `ok: false`
 * as "do not download, something is wrong," never as a user data issue.
 */
export function buildAndValidateBackup(
  items: LibraryItem[],
  collections: Collection[],
  events: ActivityEvent[],
  trackingSourceRows: ExportableTrackingSource[] = [],
): BuildAndValidateResult {
  const backup = buildBackup(items, collections, events, trackingSourceRows);
  return { ok: isValidMarklyBackup(backup), backup };
}
