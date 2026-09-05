import type {
  BackupActivityEvent,
  BackupCatalogSource,
  BackupCollection,
  BackupData,
  BackupLibraryItem,
  MarklyBackupV1,
} from "@/types/backup";
import { BACKUP_FORMAT, BACKUP_VERSION } from "@/types/backup";
import type { MetadataProvider, SupportedItemType, TrackingStatus } from "@/types/library-item";
import { SUPPORTED_ITEM_TYPES } from "@/types/library-item";
import { isValidUrl } from "@/lib/website";
import {
  normalizeEpisodeNumbering,
  normalizeNonNegativeInt,
  normalizeNonNegativeNumber,
  normalizePercent,
  normalizePositiveInt,
  normalizeProgressUnit,
  normalizeRating,
  normalizeReadingFormat,
  normalizeStatus,
  TRACKING_STATUSES,
} from "@/lib/tracking";
import {
  MAX_ACTIVITY_EVENTS,
  MAX_CATEGORY_LENGTH,
  MAX_COLLECTIONS,
  MAX_COLLECTION_NAME_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_ITEM_IDS_PER_COLLECTION,
  MAX_LIBRARY_ITEMS,
  MAX_STRING_ARRAY_ITEM_LENGTH,
  MAX_STRING_ARRAY_LENGTH,
  MAX_TITLE_LENGTH,
  MAX_URL_LENGTH,
} from "@/lib/backup/limits";

/**
 * Stage 29 — the untrusted-input boundary for backup files. Never
 * `JSON.parse → cast → insert`: every field is read as `unknown` and
 * explicitly checked. Two tiers of failure, matching the README's
 * documented import contract:
 *   - STRUCTURAL problems (wrong format, unsupported version, a malformed
 *     root/section that isn't even shaped like the format at all, or a
 *     record count over the hard limit) reject the WHOLE file — there is
 *     no safe partial reading of a file whose basic shape is wrong.
 *   - Per-RECORD problems (one item with a bad URL, an activity event
 *     whose timestamp doesn't parse, a dangling relationship) drop just
 *     that record and continue — the same "clamp or drop, never fail the
 *     whole array" policy `lib/library-storage.ts`'s local validator
 *     already uses for exactly this kind of tolerant-but-safe parsing.
 */

export type ValidateBackupFailureReason =
  | "not_json"
  | "wrong_format"
  | "unsupported_version"
  | "malformed_root"
  | "too_large"
  | "too_many_records";

export interface ValidatedBackup {
  exportedAt: string;
  backupId: string;
  libraryItems: BackupLibraryItem[];
  collections: BackupCollection[];
  activityEvents: BackupActivityEvent[];
  skipped: { libraryItems: number; collections: number; activityEvents: number };
}

export type ValidateBackupResult =
  | { ok: true; backup: ValidatedBackup }
  | { ok: false; reason: ValidateBackupFailureReason; message: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  const time = new Date(value).getTime();
  return Number.isFinite(time);
}

function isNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

/**
 * True if any two records in `raw` claim the same string value for
 * `idField` — checked against every plain-object record with a
 * syntactically valid (non-empty string) id, regardless of whether the
 * rest of that record would otherwise validate: the ambiguity is in the
 * id itself, not in whether either record turns out to be otherwise
 * well-formed. See validateBackupObject's call site for why this rejects
 * the whole file rather than dropping one occurrence.
 */
function hasDuplicateId(records: unknown[], idField: "backupItemId" | "backupCollectionId"): boolean {
  const seen = new Set<string>();
  for (const raw of records) {
    if (!isPlainObject(raw)) continue;
    const id = raw[idField];
    if (typeof id !== "string" || id.length === 0) continue;
    if (seen.has(id)) return true;
    seen.add(id);
  }
  return false;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0 && entry.length <= MAX_STRING_ARRAY_ITEM_LENGTH)
    .slice(0, MAX_STRING_ARRAY_LENGTH);
}

const KNOWN_PROVIDERS: readonly MetadataProvider[] = ["anilist", "open-library", "tmdb", "rawg"];

function normalizeCatalogSource(value: unknown): BackupCatalogSource | undefined {
  if (!isPlainObject(value)) return undefined;
  const provider = value.provider;
  const externalId = value.externalId;
  if (typeof provider !== "string" || !(KNOWN_PROVIDERS as readonly string[]).includes(provider)) return undefined;
  if (typeof externalId !== "string" || externalId.length === 0 || externalId.length > 200) return undefined;
  return { provider: provider as MetadataProvider, externalId };
}

function normalizeUrlField(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL_LENGTH) return undefined;
  return isValidUrl(value) ? value : undefined;
}

const SUPPORTED_TYPE_SET = new Set<string>(SUPPORTED_ITEM_TYPES);

/** Validates one library item record. Returns null (drop, never falls through) for anything structurally unsalvageable — an item with no usable identity at all. Every other field independently clamps/drops rather than failing the whole record, mirroring lib/library-storage.ts's local validator. Duplicate backupItemId is NOT handled here — see validateBackupObject's upfront structural check, which rejects the whole file before this ever runs. */
function validateLibraryItem(raw: unknown): BackupLibraryItem | null {
  if (!isPlainObject(raw)) return null;

  const backupItemId = raw.backupItemId;
  if (typeof backupItemId !== "string" || backupItemId.length === 0) return null;

  const type = raw.type;
  if (typeof type !== "string" || !SUPPORTED_TYPE_SET.has(type)) return null;
  const itemType = type as SupportedItemType;

  if (!isNonEmptyString(raw.title, MAX_TITLE_LENGTH)) return null;
  if (!isValidIsoDate(raw.createdAt)) return null;

  if (itemType === "website") {
    const url = normalizeUrlField(raw.url);
    if (!url) return null;
    return {
      backupItemId,
      type: "website",
      title: raw.title,
      description: typeof raw.description === "string" ? raw.description.slice(0, MAX_DESCRIPTION_LENGTH) : "",
      category: typeof raw.category === "string" ? raw.category.slice(0, MAX_CATEGORY_LENGTH) : "",
      tags: normalizeStringArray(raw.tags),
      favorite: raw.favorite === true,
      createdAt: raw.createdAt,
      updatedAt: isValidIsoDate(raw.updatedAt) ? raw.updatedAt : undefined,
      url,
    };
  }

  const item: BackupLibraryItem = {
    backupItemId,
    type: itemType,
    title: raw.title,
    description: typeof raw.description === "string" ? raw.description.slice(0, MAX_DESCRIPTION_LENGTH) : "",
    category: typeof raw.category === "string" ? raw.category.slice(0, MAX_CATEGORY_LENGTH) : "",
    tags: normalizeStringArray(raw.tags),
    favorite: raw.favorite === true,
    createdAt: raw.createdAt,
    updatedAt: isValidIsoDate(raw.updatedAt) ? raw.updatedAt : undefined,
    imageUrl: normalizeUrlField(raw.imageUrl),
    sourceUrl: normalizeUrlField(raw.sourceUrl),
    releaseYear: normalizePositiveInt(raw.releaseYear),
    catalogSource: normalizeCatalogSource(raw.catalogSource),
    status: normalizeStatus(raw.status),
    rating: normalizeRating(raw.rating),
  };

  switch (itemType) {
    case "anime":
      item.currentEpisode = normalizeNonNegativeInt(raw.currentEpisode);
      item.totalEpisodes = normalizePositiveInt(raw.totalEpisodes);
      item.episodeNumbering = normalizeEpisodeNumbering(raw.episodeNumbering);
      item.currentSeason = item.episodeNumbering === "seasonal" ? normalizePositiveInt(raw.currentSeason) : undefined;
      item.genres = normalizeStringArray(raw.genres);
      item.studio = isNonEmptyString(raw.studio, MAX_STRING_ARRAY_ITEM_LENGTH) ? raw.studio : undefined;
      break;
    case "series":
      item.currentEpisode = normalizeNonNegativeInt(raw.currentEpisode);
      item.totalEpisodes = normalizePositiveInt(raw.totalEpisodes);
      item.episodeNumbering = normalizeEpisodeNumbering(raw.episodeNumbering);
      item.currentSeason = item.episodeNumbering === "seasonal" ? normalizePositiveInt(raw.currentSeason) : undefined;
      item.genres = normalizeStringArray(raw.genres);
      break;
    case "manga":
      item.currentChapter = normalizeNonNegativeNumber(raw.currentChapter);
      item.totalChapters = normalizePositiveInt(raw.totalChapters);
      item.genres = normalizeStringArray(raw.genres);
      item.authors = normalizeStringArray(raw.authors);
      break;
    case "novel": {
      const progressUnit = normalizeProgressUnit(raw.progressUnit);
      item.progressUnit = progressUnit;
      item.progressValue =
        progressUnit === undefined
          ? undefined
          : progressUnit === "percent"
            ? normalizePercent(raw.progressValue)
            : normalizeNonNegativeNumber(raw.progressValue);
      item.authors = normalizeStringArray(raw.authors);
      item.pageCount = normalizePositiveInt(raw.pageCount);
      item.readingFormat = normalizeReadingFormat(raw.readingFormat);
      break;
    }
    case "movie":
      item.genres = normalizeStringArray(raw.genres);
      break;
    case "game":
      item.platform = isNonEmptyString(raw.platform, MAX_STRING_ARRAY_ITEM_LENGTH) ? raw.platform : undefined;
      item.playtimeHours = normalizeNonNegativeNumber(raw.playtimeHours);
      item.developer = isNonEmptyString(raw.developer, MAX_STRING_ARRAY_ITEM_LENGTH) ? raw.developer : undefined;
      item.publisher = isNonEmptyString(raw.publisher, MAX_STRING_ARRAY_ITEM_LENGTH) ? raw.publisher : undefined;
      item.catalogPlatforms = normalizeStringArray(raw.catalogPlatforms);
      break;
  }

  return item;
}

/** Duplicate backupCollectionId is NOT handled here — see validateBackupObject's upfront structural check. */
function validateCollection(raw: unknown, validItemIds: Set<string>, exportedAt: string): BackupCollection | null {
  if (!isPlainObject(raw)) return null;
  const backupCollectionId = raw.backupCollectionId;
  if (typeof backupCollectionId !== "string" || backupCollectionId.length === 0) return null;
  if (!isNonEmptyString(raw.name, MAX_COLLECTION_NAME_LENGTH)) return null;

  const itemIds = Array.isArray(raw.itemIds)
    ? raw.itemIds.filter((id): id is string => typeof id === "string" && validItemIds.has(id)).slice(0, MAX_ITEM_IDS_PER_COLLECTION)
    : [];

  return {
    backupCollectionId,
    name: raw.name,
    description: typeof raw.description === "string" ? raw.description.slice(0, MAX_DESCRIPTION_LENGTH) : undefined,
    createdAt: isValidIsoDate(raw.createdAt) ? raw.createdAt : exportedAt,
    itemIds,
  };
}

const PROGRESS_KINDS = ["episode", "chapter", "page", "percent", "playtime", "season_episode"] as const;

function validateActivityEvent(raw: unknown, validItemIds: Set<string>): BackupActivityEvent | null {
  if (!isPlainObject(raw)) return null;
  const itemId = raw.itemId;
  if (typeof itemId !== "string" || !validItemIds.has(itemId)) return null;
  if (!isValidIsoDate(raw.timestamp)) return null;

  switch (raw.type) {
    case "progress_updated": {
      if (typeof raw.progressKind !== "string" || !(PROGRESS_KINDS as readonly string[]).includes(raw.progressKind)) return null;
      if (typeof raw.newValue !== "number" || !Number.isFinite(raw.newValue)) return null;
      return {
        itemId,
        type: "progress_updated",
        timestamp: raw.timestamp,
        progressKind: raw.progressKind as (typeof PROGRESS_KINDS)[number],
        previousValue: typeof raw.previousValue === "number" && Number.isFinite(raw.previousValue) ? raw.previousValue : undefined,
        newValue: raw.newValue,
        previousSeason: typeof raw.previousSeason === "number" && Number.isFinite(raw.previousSeason) ? raw.previousSeason : undefined,
        newSeason: typeof raw.newSeason === "number" && Number.isFinite(raw.newSeason) ? raw.newSeason : undefined,
      };
    }
    case "rating_updated":
      return {
        itemId,
        type: "rating_updated",
        timestamp: raw.timestamp,
        previousValue: typeof raw.previousValue === "number" && Number.isFinite(raw.previousValue) ? raw.previousValue : undefined,
        newValue: typeof raw.newValue === "number" && Number.isFinite(raw.newValue) ? raw.newValue : undefined,
      };
    case "status_updated": {
      if (typeof raw.newValue !== "string" || !(TRACKING_STATUSES as readonly string[]).includes(raw.newValue)) return null;
      const previous: TrackingStatus | undefined =
        typeof raw.previousValue === "string" && (TRACKING_STATUSES as readonly string[]).includes(raw.previousValue)
          ? (raw.previousValue as TrackingStatus)
          : undefined;
      return {
        itemId,
        type: "status_updated",
        timestamp: raw.timestamp,
        previousValue: previous,
        newValue: raw.newValue as TrackingStatus,
      };
    }
    case "item_added":
      return { itemId, type: "item_added", timestamp: raw.timestamp };
    default:
      return null;
  }
}

/**
 * Validates a raw parsed JSON value against the backup v1 contract. Never
 * throws — every failure mode returns a typed result with a plain-language
 * message. Call `validateBackupFile` instead when starting from a `File`
 * (it also enforces the file-size limit before this ever runs).
 */
export function validateBackupObject(raw: unknown): ValidateBackupResult {
  if (!isPlainObject(raw)) {
    return { ok: false, reason: "wrong_format", message: "Not a Markly backup." };
  }
  if (raw.format !== BACKUP_FORMAT) {
    return { ok: false, reason: "wrong_format", message: "Not a Markly backup." };
  }
  if (typeof raw.version !== "number" || !Number.isInteger(raw.version) || raw.version < 1) {
    return { ok: false, reason: "malformed_root", message: "This backup is damaged or contains invalid data." };
  }
  if (raw.version > BACKUP_VERSION) {
    return { ok: false, reason: "unsupported_version", message: "This backup uses a newer unsupported version." };
  }
  if (!isValidIsoDate(raw.exportedAt)) {
    return { ok: false, reason: "malformed_root", message: "This backup is damaged or contains invalid data." };
  }
  if (!isPlainObject(raw.data)) {
    return { ok: false, reason: "malformed_root", message: "This backup is damaged or contains invalid data." };
  }

  const data = raw.data as Partial<Record<keyof BackupData, unknown>>;
  const rawItems = data.libraryItems;
  const rawCollections = data.collections;
  const rawActivity = data.activityEvents;
  if (
    (rawItems !== undefined && !Array.isArray(rawItems)) ||
    (rawCollections !== undefined && !Array.isArray(rawCollections)) ||
    (rawActivity !== undefined && !Array.isArray(rawActivity))
  ) {
    return { ok: false, reason: "malformed_root", message: "This backup is damaged or contains invalid data." };
  }

  const itemsArray = Array.isArray(rawItems) ? rawItems : [];
  const collectionsArray = Array.isArray(rawCollections) ? rawCollections : [];
  const activityArray = Array.isArray(rawActivity) ? rawActivity : [];

  if (itemsArray.length > MAX_LIBRARY_ITEMS || collectionsArray.length > MAX_COLLECTIONS || activityArray.length > MAX_ACTIVITY_EVENTS) {
    return { ok: false, reason: "too_many_records", message: "This backup is too large to import." };
  }

  // Backup-local ids define this file's graph identity — a Collection or
  // Activity record can only reference an item by its backupItemId, and
  // a membership can only reference a collection by its
  // backupCollectionId. Two records claiming the SAME id makes any
  // reference to that id structurally ambiguous (which one did it mean?),
  // so this is a whole-file STRUCTURAL failure, rejected here — before
  // any per-record validation, preview, or mutation — never resolved by
  // silently keeping one occurrence and dropping the other.
  if (hasDuplicateId(itemsArray, "backupItemId") || hasDuplicateId(collectionsArray, "backupCollectionId")) {
    return { ok: false, reason: "malformed_root", message: "This backup is damaged or contains invalid data." };
  }

  const exportedAt = raw.exportedAt;
  const backupId = typeof raw.backupId === "string" ? raw.backupId : "";

  const libraryItems: BackupLibraryItem[] = [];
  let skippedItems = 0;
  for (const rawItem of itemsArray) {
    const item = validateLibraryItem(rawItem);
    if (item) libraryItems.push(item);
    else skippedItems++;
  }

  const validItemIds = new Set(libraryItems.map((item) => item.backupItemId));

  const collections: BackupCollection[] = [];
  let skippedCollections = 0;
  for (const rawCollection of collectionsArray) {
    const collection = validateCollection(rawCollection, validItemIds, exportedAt);
    if (collection) collections.push(collection);
    else skippedCollections++;
  }

  const activityEvents: BackupActivityEvent[] = [];
  let skippedActivity = 0;
  for (const rawEvent of activityArray) {
    const event = validateActivityEvent(rawEvent, validItemIds);
    if (event) activityEvents.push(event);
    else skippedActivity++;
  }

  // If the file had records but literally every single one was invalid,
  // treat this as a malformed file rather than a suspiciously-empty
  // "successful" import — matches "reject malformed required fields"
  // rather than silently reporting 0 new items for a garbage file.
  if (itemsArray.length > 0 && libraryItems.length === 0) {
    return { ok: false, reason: "malformed_root", message: "This backup is damaged or contains invalid data." };
  }

  return {
    ok: true,
    backup: {
      exportedAt,
      backupId,
      libraryItems,
      collections,
      activityEvents,
      skipped: { libraryItems: skippedItems, collections: skippedCollections, activityEvents: skippedActivity },
    },
  };
}

export interface ValidateBackupFileOptions {
  maxFileSizeBytes: number;
}

/** Entry point for an actual uploaded File — enforces the size limit before ever reading/parsing its contents. */
export async function validateBackupFile(file: File, options: ValidateBackupFileOptions): Promise<ValidateBackupResult> {
  if (file.size > options.maxFileSizeBytes) {
    return { ok: false, reason: "too_large", message: "This backup is too large to import." };
  }

  let text: string;
  try {
    text = await file.text();
  } catch {
    return { ok: false, reason: "not_json", message: "This backup is damaged or contains invalid data." };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "not_json", message: "This backup is damaged or contains invalid data." };
  }

  return validateBackupObject(parsed);
}

/** Used by export to prove the file it's about to offer for download is itself valid against this exact validator — see lib/backup/export.ts. */
export function isValidMarklyBackup(backup: MarklyBackupV1): boolean {
  return validateBackupObject(backup).ok;
}
