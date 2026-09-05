import type { ActivityEvent } from "@/types/activity";
import type { Collection } from "@/types/collection";
import type { LibraryItem, MediaItem, WebsiteItem } from "@/types/library-item";
import type { BackupActivityEvent, BackupLibraryItem } from "@/types/backup";
import type { ImportPlan } from "@/lib/backup/plan";
import { generateId } from "@/lib/utils";
import { MAX_ACTIVITY_EVENTS } from "@/lib/activity-storage";

/**
 * Stage 29 — local-mode import apply. Builds the ENTIRE resulting
 * items/collections/activity arrays in memory first and returns them as
 * one bundle; the caller (the Settings import flow) persists all three
 * localStorage stores together, synchronously, only after this returns
 * successfully. Nothing here mutates `currentItems`/`currentCollections`/
 * `currentEvents` in place — every array returned is a new one.
 *
 * This mirrors the exact ordering lesson from Stage 27's local-mode merge
 * bug: useCollections' self-healing effect strips any itemId not present
 * in `items`, reacting whenever `items` changes. Since this module
 * returns items/collections/activity as one bundle rather than three
 * separate state updates, the caller can apply all three in the same
 * synchronous render (setItems/setCollections/setEvents back to back)
 * with no intermediate render where collections could reference an item
 * id that doesn't exist in `items` yet — the same hazard, avoided the
 * same way.
 *
 * localStorage itself is not transactional (three separate `setItem`
 * calls) — see README "Portable Backup, Export & Import" for the
 * documented limitation this accepts rather than pretends away.
 */
export interface LocalImportResult {
  items: LibraryItem[];
  collections: Collection[];
  events: ActivityEvent[];
  /** How many of `plan.activityToImport` actually survive in `events`. */
  activityImportedCount: number;
  /** How many of `plan.activityToImport` were dropped purely for capacity — never for validity. */
  activitySkippedForCapacity: number;
}

/**
 * Local-mode-only Activity capacity policy. `activity-storage.ts`'s
 * `saveActivity()` silently trims any array over `capacity` down to its
 * first N positions at write time — normally a no-op distinction from
 * "most recent N," since `useActivity`'s `logEvent` always prepends new
 * events in real time, keeping the array already newest-first. Import is
 * the one path that can hand `saveActivity` an out-of-chronological-order
 * combination (existing history + a backup's own history), so this
 * function re-sorts the COMBINED set by timestamp before capping, to make
 * sure "most recent 500" is actually what survives rather than whichever
 * half happened to land in the first N array slots.
 *
 * This intentionally duplicates just enough of saveActivity's own trim
 * behavior (same constant, same cap-to-N semantics) to make the result
 * this function returns already durable — so the caller can report an
 * accurate "restored" count instead of one that quietly shrinks the next
 * time the store persists. It does not change `activity-storage.ts`
 * itself or its behavior for any non-import write.
 */
export interface LocalActivityRetentionResult<T> {
  events: T[];
  importedCount: number;
  skippedForCapacity: number;
}

/**
 * Generic over the current/new element shapes (constrained only to
 * `id`/`timestamp`) so the SAME trim logic can compute an exact
 * preview-time capacity estimate from lightweight placeholder records
 * (see BackupSettingsPanel's preview annotation, which doesn't have real
 * item ids to build full ActivityEvent objects with yet) as well as the
 * real apply-time result from actual ActivityEvent objects — the two
 * must never diverge, since the preview promises a count the apply step
 * then has to actually deliver (Stage 29 Part B).
 */
export function computeLocalActivityRetention<TCurrent extends { id: string; timestamp: string }, TNew extends { id: string; timestamp: string }>(
  currentEvents: TCurrent[],
  newEvents: TNew[],
  capacity: number,
): LocalActivityRetentionResult<TCurrent | TNew> {
  const combined: (TCurrent | TNew)[] = [...currentEvents, ...newEvents];
  combined.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const kept = combined.length > capacity ? combined.slice(0, capacity) : combined;
  const keptIds = new Set(kept.map((event) => event.id));
  const importedCount = newEvents.filter((event) => keptIds.has(event.id)).length;
  return { events: kept, importedCount, skippedForCapacity: newEvents.length - importedCount };
}

function fromBackupLibraryItem(backupItem: BackupLibraryItem, id: string): LibraryItem {
  const base = {
    id,
    title: backupItem.title,
    description: backupItem.description,
    category: backupItem.category,
    tags: backupItem.tags,
    favorite: backupItem.favorite,
    createdAt: backupItem.createdAt,
    updatedAt: backupItem.updatedAt,
  };

  if (backupItem.type === "website") {
    const website: WebsiteItem = { ...base, type: "website", url: backupItem.url ?? "" };
    return website;
  }

  const media = {
    ...base,
    imageUrl: backupItem.imageUrl,
    sourceUrl: backupItem.sourceUrl,
    releaseYear: backupItem.releaseYear,
    catalogSource: backupItem.catalogSource,
    status: backupItem.status ?? "planned",
    rating: backupItem.rating,
  };

  switch (backupItem.type) {
    case "anime":
      return {
        ...media,
        type: "anime",
        currentEpisode: backupItem.currentEpisode,
        totalEpisodes: backupItem.totalEpisodes,
        episodeNumbering: backupItem.episodeNumbering,
        currentSeason: backupItem.currentSeason,
        genres: backupItem.genres,
        studio: backupItem.studio,
      } satisfies MediaItem;
    case "series":
      return {
        ...media,
        type: "series",
        currentEpisode: backupItem.currentEpisode,
        totalEpisodes: backupItem.totalEpisodes,
        episodeNumbering: backupItem.episodeNumbering,
        currentSeason: backupItem.currentSeason,
        genres: backupItem.genres,
      } satisfies MediaItem;
    case "manga":
      return {
        ...media,
        type: "manga",
        currentChapter: backupItem.currentChapter,
        totalChapters: backupItem.totalChapters,
        genres: backupItem.genres,
        authors: backupItem.authors,
      } satisfies MediaItem;
    case "novel":
      return {
        ...media,
        type: "novel",
        progressValue: backupItem.progressValue,
        progressUnit: backupItem.progressUnit,
        authors: backupItem.authors,
        pageCount: backupItem.pageCount,
        readingFormat: backupItem.readingFormat,
      } satisfies MediaItem;
    case "movie":
      return { ...media, type: "movie", genres: backupItem.genres } satisfies MediaItem;
    case "game":
      return {
        ...media,
        type: "game",
        platform: backupItem.platform,
        playtimeHours: backupItem.playtimeHours,
        developer: backupItem.developer,
        publisher: backupItem.publisher,
        catalogPlatforms: backupItem.catalogPlatforms,
      } satisfies MediaItem;
    default:
      // article/video/other — never actually produced by the validator
      // for a supported-types-only backup, but exhaustively handled.
      return { ...base, type: backupItem.type };
  }
}

function fromBackupActivityEvent(event: BackupActivityEvent, itemId: string): ActivityEvent {
  const id = generateId();
  switch (event.type) {
    case "progress_updated":
      return {
        id,
        itemId,
        timestamp: event.timestamp,
        type: "progress_updated",
        progressKind: event.progressKind,
        previousValue: event.previousValue,
        newValue: event.newValue,
        previousSeason: event.previousSeason,
        newSeason: event.newSeason,
      };
    case "rating_updated":
      return { id, itemId, timestamp: event.timestamp, type: "rating_updated", previousValue: event.previousValue, newValue: event.newValue };
    case "status_updated":
      return { id, itemId, timestamp: event.timestamp, type: "status_updated", previousValue: event.previousValue, newValue: event.newValue };
    case "item_added":
      return { id, itemId, timestamp: event.timestamp, type: "item_added" };
  }
}

export function applyImportPlanLocally(
  plan: ImportPlan,
  currentItems: LibraryItem[],
  currentCollections: Collection[],
  currentEvents: ActivityEvent[],
): LocalImportResult {
  // 1. Create new items with fresh local ids.
  const newIdByBackupItemId = new Map<string, string>();
  const newItems: LibraryItem[] = [];
  for (const entry of plan.items) {
    if (entry.action !== "create") continue;
    const newId = generateId();
    newIdByBackupItemId.set(entry.backupItem.backupItemId, newId);
    newItems.push(fromBackupLibraryItem(entry.backupItem, newId));
  }

  // 2. Resolve every backupItemId this plan can attach anything to —
  // either a just-created item, or an already_present mapped existing one.
  const resolvedItemId = new Map<string, string>();
  for (const entry of plan.items) {
    if (entry.action === "create") resolvedItemId.set(entry.backupItem.backupItemId, newIdByBackupItemId.get(entry.backupItem.backupItemId)!);
    else if (entry.classification === "already_present" && entry.existingItemId) resolvedItemId.set(entry.backupItem.backupItemId, entry.existingItemId);
  }

  // 3. Group memberships by target collection (backup id), as resolved real item ids.
  const membershipsByBackupCollectionId = new Map<string, Set<string>>();
  for (const membership of plan.memberships) {
    const realItemId = resolvedItemId.get(membership.backupItemId);
    if (!realItemId) continue; // defensive; the plan should never include an unresolvable pair
    const set = membershipsByBackupCollectionId.get(membership.backupCollectionId) ?? new Set<string>();
    set.add(realItemId);
    membershipsByBackupCollectionId.set(membership.backupCollectionId, set);
  }

  // 4. Apply to reused collections (dedupe against what's already there) and build new ones.
  const reusedTargets = new Map(
    plan.collections.filter((entry) => entry.action === "reuse").map((entry) => [entry.existingCollectionId!, entry.backupCollection.backupCollectionId]),
  );
  const collections: Collection[] = currentCollections.map((collection) => {
    const backupCollectionId = reusedTargets.get(collection.id);
    if (!backupCollectionId) return collection;
    const toAdd = membershipsByBackupCollectionId.get(backupCollectionId);
    if (!toAdd || toAdd.size === 0) return collection;
    const itemIds = [...collection.itemIds];
    toAdd.forEach((id) => {
      if (!itemIds.includes(id)) itemIds.push(id);
    });
    return { ...collection, itemIds, updatedAt: new Date().toISOString() };
  });

  for (const entry of plan.collections) {
    if (entry.action !== "create") continue;
    const toAdd = membershipsByBackupCollectionId.get(entry.backupCollection.backupCollectionId);
    collections.push({
      id: generateId(),
      name: entry.backupCollection.name,
      description: entry.backupCollection.description,
      itemIds: toAdd ? [...toAdd] : [],
      createdAt: entry.backupCollection.createdAt,
    });
  }

  // 5. Activity — only ever for newly-created items (see ImportPlan's own
  // doc comment on why this, not a provenance table, is what keeps
  // repeated import idempotent). Sorted newest-first among themselves to
  // match this store's existing array-order convention (see
  // hooks/useActivity.ts's logEvent, which always prepends).
  const newEvents = [...plan.activityToImport]
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .map((event) => fromBackupActivityEvent(event, resolvedItemId.get(event.itemId)!));

  const retained = computeLocalActivityRetention(currentEvents, newEvents, MAX_ACTIVITY_EVENTS);

  return {
    items: [...currentItems, ...newItems],
    collections,
    events: retained.events,
    activityImportedCount: retained.importedCount,
    activitySkippedForCapacity: retained.skippedForCapacity,
  };
}
