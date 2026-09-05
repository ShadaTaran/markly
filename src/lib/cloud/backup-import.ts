import type { SupabaseClient } from "@supabase/supabase-js";
import type { ImportPlan } from "@/lib/backup/plan";
import { generateId } from "@/lib/utils";

/**
 * Stage 29 — builds the JSONB payload for the `import_library_backup` RPC
 * (supabase/migrations/0013_stage29_backup_import.sql, deployed; fixed by
 * 0014_stage29_backup_import_fix.sql, NOT yet deployed) from an
 * already-computed ImportPlan, and calls it. The server independently
 * re-verifies ownership of every "existing" id this payload references,
 * re-derives Activity idempotency itself, and (as of 0014) revalidates
 * every "new" candidate's identity against current state under a
 * per-user lock before creating it — see that migration's own doc
 * comment; this module only ever sends what Preview already showed the
 * user, never anything Preview decided to skip.
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
}

const RESULT_STATUSES: readonly CloudImportResult["status"][] = ["imported", "unauthorized", "invalid_plan", "duplicate_request", "plan_too_large"];

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
  };
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
