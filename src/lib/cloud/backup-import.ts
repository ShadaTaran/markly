import type { SupabaseClient } from "@supabase/supabase-js";
import type { ImportPlan } from "@/lib/backup/plan";
import type { BackupTrackingSource } from "@/types/backup";
import { generateId } from "@/lib/utils";

/**
 * Stage 29 — builds the JSONB payload for the `import_library_backup` RPC
 * (supabase/migrations/0013_stage29_backup_import.sql and
 * 0014_stage29_backup_import_fix.sql, both deployed; extended, additively,
 * by 0018_stage40_backup_item_map.sql — NOT yet applied to production,
 * pending disposable-database validation and separate deploy approval —
 * see that migration's own doc comment) from an already-computed
 * ImportPlan, and calls it. The server independently re-verifies
 * ownership of every "existing" id this payload references, re-derives
 * Activity idempotency itself, and revalidates every "new" candidate's
 * identity against current state under a per-user lock before creating
 * it; this module only ever sends what Preview already showed the user,
 * never anything Preview decided to skip.
 */

interface ItemPayload {
  backupItemId: string;
  type: string;
  title: string;
  description: string;
  category: string;
  tags: string[];
  favorite: boolean;
  createdAt: string;
  updatedAt?: string;
  url?: string;
  imageUrl?: string;
  sourceUrl?: string;
  releaseYear?: number;
  catalogSource?: { provider: string; externalId: string };
  status?: string;
  rating?: number;
  currentEpisode?: number;
  totalEpisodes?: number;
  episodeNumbering?: string;
  currentSeason?: number;
  genres?: string[];
  studio?: string;
  currentChapter?: number;
  totalChapters?: number;
  authors?: string[];
  progressValue?: number;
  progressUnit?: string;
  pageCount?: number;
  readingFormat?: string;
  platform?: string;
  playtimeHours?: number;
  developer?: string;
  publisher?: string;
  catalogPlatforms?: string[];
  /**
   * True only when this item's classification was "possible_duplicate"
   * and the user explicitly opted in (Section 30's checkbox) — the only
   * way such an item reaches this payload at all. Tells the server this
   * item must NEVER be revalidated/remapped against current state by the
   * race-safety check in 0014: an explicit "import it anyway" choice must
   * survive regardless of what else exists (see that migration's own doc
   * comment, Issue A / DEFECT 3). Omitted (falsy) for a genuinely "new"
   * item, which IS subject to that revalidation.
   */
  possibleDuplicateOptIn: boolean;
}

function buildItemsPayload(plan: ImportPlan): ItemPayload[] {
  return plan.items
    .filter((entry) => entry.action === "create")
    .map((entry): ItemPayload => ({ ...entry.backupItem, possibleDuplicateOptIn: entry.classification === "possible_duplicate" }));
}

interface ActivityPayload {
  backupItemId: string;
  type: string;
  timestamp: string;
  progressKind?: string;
  previousValue?: number;
  newValue?: number;
  previousSeason?: number;
  newSeason?: number;
  previousStatus?: string;
  newStatus?: string;
}

function buildActivityPayload(plan: ImportPlan): ActivityPayload[] {
  return plan.activityToImport.map((event): ActivityPayload => {
    const base = { backupItemId: event.itemId, type: event.type, timestamp: event.timestamp };
    switch (event.type) {
      case "progress_updated":
        return {
          ...base,
          progressKind: event.progressKind,
          previousValue: event.previousValue,
          newValue: event.newValue,
          previousSeason: event.previousSeason,
          newSeason: event.newSeason,
        };
      case "rating_updated":
        return { ...base, previousValue: event.previousValue, newValue: event.newValue };
      case "status_updated":
        // Distinct field names from progress/rating's numeric
        // previousValue/newValue — see 0013's recordset column typing for why.
        return { ...base, previousStatus: event.previousValue, newStatus: event.newValue };
      case "item_added":
        return base;
    }
  });
}

export interface CloudImportResult {
  status: "imported" | "unauthorized" | "invalid_plan" | "duplicate_request" | "plan_too_large";
  itemsCreated?: number;
  /**
   * Stage 29 0014 (Issue A / DEFECT 3) — count of "new" candidates that
   * turned out to already exist by the time this call's transaction ran
   * (a concurrent import for the same user committed an authoritative
   * match first) and were mapped to the existing item instead of creating
   * a duplicate. Distinct from itemsCreated so the client can report what
   * actually happened rather than the plan's original (possibly stale)
   * expectation — see that migration's comment for the full design.
   */
  itemsReused?: number;
  collectionsCreated?: number;
  collectionsReused?: number;
  activityCreated?: number;
  /**
   * Migration 0018 addition — the authoritative backupItemId -> real
   * LibraryItem id mapping for EVERY item this call created or
   * authoritatively matched, straight from the RPC's own
   * pg_temp.import_item_map. This is the ONLY correct way to know a
   * newly-created item's real id; never re-derive it via title/type
   * matching client-side. Always an array (possibly empty), never
   * undefined, for any client running against a database that has 0018
   * applied — see parseResult below for the pre-0018 fallback.
   */
  itemMap?: ImportItemMapEntry[];
}

export interface ImportItemMapEntry {
  backupItemId: string;
  realItemId: string;
  wasCreated: boolean;
}

const RESULT_STATUSES: readonly CloudImportResult["status"][] = ["imported", "unauthorized", "invalid_plan", "duplicate_request", "plan_too_large"];

function parseItemMap(value: unknown): ImportItemMapEntry[] {
  // Absent entirely (a database that hasn't had 0018 applied yet) is
  // treated as "nothing resolvable" rather than a parse failure — the
  // rest of the response (status, itemsCreated, ...) is still valid and
  // must not be rejected just because this one additive field is missing.
  if (!Array.isArray(value)) return [];
  const entries: ImportItemMapEntry[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    if (typeof record.backupItemId !== "string" || typeof record.realItemId !== "string" || typeof record.wasCreated !== "boolean") continue;
    entries.push({ backupItemId: record.backupItemId, realItemId: record.realItemId, wasCreated: record.wasCreated });
  }
  return entries;
}

function parseResult(data: unknown): CloudImportResult | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  const status = record.status;
  if (typeof status !== "string" || !(RESULT_STATUSES as readonly string[]).includes(status)) return null;
  return {
    status: status as CloudImportResult["status"],
    itemsCreated: typeof record.itemsCreated === "number" ? record.itemsCreated : undefined,
    itemsReused: typeof record.itemsReused === "number" ? record.itemsReused : undefined,
    collectionsCreated: typeof record.collectionsCreated === "number" ? record.collectionsCreated : undefined,
    collectionsReused: typeof record.collectionsReused === "number" ? record.collectionsReused : undefined,
    activityCreated: typeof record.activityCreated === "number" ? record.activityCreated : undefined,
    itemMap: parseItemMap(record.itemMap),
  };
}

export interface RestoreTrackingSourcesResult {
  created: number;
  linked: number;
  alreadyLinked: number;
  conflicts: number;
  suppressedElsewhere: number;
  skippedInvalid: number;
  /** A backup source whose backupItemId has no entry in itemMap at all (its parent was skipped as a title-only race match, a dangling reference, or a possible-duplicate not opted in) — skipped safely, never guessed at. */
  unresolvable: number;
}

/** The server's own response shape — `unresolvable` is computed client-side (see restoreTrackingSourcesFromBackup) and is never part of the /api/tracking-sources/restore response itself. */
type RestoreSourcesServerResult = Omit<RestoreTrackingSourcesResult, "unresolvable">;

function parseRestoreResult(data: unknown): RestoreSourcesServerResult | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  const num = (key: string) => (typeof record[key] === "number" ? (record[key] as number) : 0);
  return {
    created: num("created"),
    linked: num("linked"),
    alreadyLinked: num("alreadyLinked"),
    conflicts: num("conflicts"),
    suppressedElsewhere: num("suppressedElsewhere"),
    skippedInvalid: num("skippedInvalid"),
  };
}

/**
 * Stage 40 data-integrity correction — Part A, completed by migration
 * 0018. Called AFTER importLibraryBackup has already succeeded, never
 * before: TrackingSources only make sense once their parent LibraryItem
 * definitely exists (Stage 40's own "restore order" requirement).
 * Deliberately a plain fetch to a normal Route Handler, not a second RPC
 * — restoreTrackingSource (lib/extension/tracking-sources.ts) is
 * session-authenticated application code, not SQL, so no migration is
 * needed for this half of backup restore.
 *
 * `itemMap` — straight from `importLibraryBackup`'s own response — is the
 * ONLY source of truth for resolving a backup source's parent to a real
 * LibraryItem id. This works identically for an "already_present" item
 * and a brand-new one (0018's whole point): a `wasCreated: true` and a
 * `wasCreated: false` entry are resolved exactly the same way here, never
 * distinguished by title/type/any other heuristic. A backup source whose
 * `backupItemId` has no entry in `itemMap` at all (its parent was a
 * title-only race match the server deliberately never mapped, a stale/
 * dangling reference, or a possible-duplicate the user never opted into)
 * is skipped and counted — never guessed at via any fallback matching.
 *
 * Not atomic with the main import, by the same explicit design already
 * used for Stage 39's Link Source flow: if this call fails or only
 * partially succeeds, the already-imported items/collections/activity are
 * never touched or rolled back — the caller surfaces the counts it got
 * and the user can always retry from Settings.
 */
export async function restoreTrackingSourcesFromBackup(
  backupTrackingSources: BackupTrackingSource[],
  itemMap: ImportItemMapEntry[],
): Promise<RestoreTrackingSourcesResult> {
  const realItemIdByBackupItemId = new Map(itemMap.map((entry) => [entry.backupItemId, entry.realItemId]));

  const sources: { libraryItemId: string; adapterId: string; sourceKey: string; sourceTitle: string; sourceUrl: string; autoTrackEnabled: boolean; suppressed: boolean }[] = [];
  let unresolvable = 0;
  for (const backupSource of backupTrackingSources) {
    const libraryItemId = realItemIdByBackupItemId.get(backupSource.backupItemId);
    if (!libraryItemId) {
      unresolvable++;
      continue;
    }
    sources.push({
      libraryItemId,
      adapterId: backupSource.adapterId,
      sourceKey: backupSource.sourceKey,
      sourceTitle: backupSource.sourceTitle,
      sourceUrl: backupSource.sourceUrl,
      autoTrackEnabled: backupSource.autoTrackEnabled,
      suppressed: backupSource.suppressed,
    });
  }

  if (sources.length === 0) {
    return { created: 0, linked: 0, alreadyLinked: 0, conflicts: 0, suppressedElsewhere: 0, skippedInvalid: 0, unresolvable };
  }

  const response = await fetch("/api/tracking-sources/restore", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sources }),
  });
  if (!response.ok) throw new Error("restoreTrackingSourcesFromBackup failed");

  const result = parseRestoreResult(await response.json().catch(() => null));
  if (!result) throw new Error("restoreTrackingSourcesFromBackup returned an unexpected shape");
  return { ...result, unresolvable };
}

export async function importLibraryBackup(supabase: SupabaseClient, plan: ImportPlan): Promise<CloudImportResult> {
  const payload = {
    items: buildItemsPayload(plan),
    collectionsToCreate: plan.collections.filter((entry) => entry.action === "create").map((entry) => ({
      backupCollectionId: entry.backupCollection.backupCollectionId,
      name: entry.backupCollection.name,
      description: entry.backupCollection.description,
      createdAt: entry.backupCollection.createdAt,
    })),
    collectionsToReuse: plan.collections
      .filter((entry) => entry.action === "reuse")
      .map((entry) => ({ backupCollectionId: entry.backupCollection.backupCollectionId, existingCollectionId: entry.existingCollectionId })),
    itemMappings: plan.items
      .filter((entry) => entry.classification === "already_present" && entry.existingItemId)
      .map((entry) => ({ backupItemId: entry.backupItem.backupItemId, existingItemId: entry.existingItemId })),
    memberships: plan.memberships,
    activity: buildActivityPayload(plan),
  };

  const { data, error } = await supabase.rpc("import_library_backup", {
    p_request_id: generateId(),
    p_plan: payload,
  });
  if (error) throw error;

  const result = parseResult(data);
  if (!result) throw new Error("import_library_backup returned an unexpected shape");
  return result;
}
