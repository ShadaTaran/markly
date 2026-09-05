import type { Collection } from "@/types/collection";
import type { LibraryItem } from "@/types/library-item";
import type { BackupActivityEvent, BackupCollection, BackupLibraryItem } from "@/types/backup";
import type { ValidatedBackup } from "@/lib/backup/validate";
import { isMediaItem } from "@/lib/item-detail";
import { normalizeTitleForMatching } from "@/lib/title-normalization";
import { getDomain } from "@/lib/website";

/**
 * Stage 29 — the import planner: classifies every backup record against
 * CURRENT library state and produces a plan describing exactly what
 * Import would create, reuse, or skip. Pure and synchronous — the same
 * plan is used to render the preview AND (local mode) to apply the
 * import, or (cloud mode) to build the RPC payload; nothing here mutates
 * anything.
 *
 * Identity rules deliberately reuse Stage 27's own conservative signals
 * (lib/duplicate-detection.ts) rather than inventing new ones — never
 * fuzzy, never automatic merging:
 *   - catalogSource match (same media type, same provider+externalId) →
 *     "already_present": an authoritative identity match, safe enough to
 *     map Collections/Activity onto the existing item.
 *   - exact normalized title match (same media type, no catalogSource
 *     conflict) → "possible_duplicate": the same signal Stage 27 groups
 *     for user review, but NOT safe enough to silently attach anything to
 *     — skipped by default, and even when the user opts to import it
 *     anyway (Section 30's checkbox), it's created as a genuinely
 *     separate new item, never mapped/merged (Stage 27 Merge stays the
 *     only place two items are ever combined, and only by explicit user
 *     action there).
 *   - Website items have no catalog/title-duplicate concept (Stage 27's
 *     detector only ever considers media items) — identity here is an
 *     exact normalized URL match, which is already an authoritative
 *     signal on its own.
 */

export type ItemClassification = "new" | "already_present" | "possible_duplicate";

export interface ClassifiedItem {
  backupItem: BackupLibraryItem;
  classification: ItemClassification;
  /** What actually happens — "create" for new items and (if the caller opted in) possible duplicates; "skip" otherwise. already_present NEVER creates — see existingItemId. */
  action: "create" | "skip";
  /** Only present for classification === "already_present" — the CURRENT item this backup record maps to, used to attach Collections (always) and Activity (never — see the module doc comment on Activity idempotency below). */
  existingItemId?: string;
}

export interface ClassifiedCollection {
  backupCollection: BackupCollection;
  action: "create" | "reuse";
  existingCollectionId?: string;
}

export interface CollectionMembershipPlan {
  backupCollectionId: string;
  backupItemId: string;
}

export interface ImportPlanCounts {
  itemsNew: number;
  itemsAlreadyPresent: number;
  itemsPossibleDuplicate: number;
  itemsPossibleDuplicateIncluded: number;
  collectionsNew: number;
  collectionsReuse: number;
  activityImport: number;
  activitySkipped: number;
}

export interface ImportPlan {
  exportedAt: string;
  items: ClassifiedItem[];
  collections: ClassifiedCollection[];
  /** Only pairs whose item resolves to something real (a to-be-created item or a mapped existing item) — a membership referencing a skipped possible-duplicate is silently omitted, never left dangling. */
  memberships: CollectionMembershipPlan[];
  /**
   * Activity is imported ONLY for items with action "create" — never for
   * an "already_present" mapping, even though that mapping is trusted
   * enough for Collections. This is deliberate, not an oversight: it is
   * what makes repeated import of the same backup idempotent for
   * Activity without needing any provenance table (Section 34/35 of the
   * spec) — collection_items has a composite primary key and every write
   * path already uses ON CONFLICT DO NOTHING (safe to repeat), but
   * activity_events has no equivalent natural uniqueness, so re-attaching
   * imported history to an already-present item on a second import of
   * the same file would create duplicate history every time. Restricting
   * Activity to genuinely-new items sidesteps that entirely: a second
   * import reclassifies those same items as already_present and their
   * Activity is correctly skipped, at the small, explicit cost of never
   * importing history onto an item that turned out to already exist.
   */
  activityToImport: BackupActivityEvent[];
  counts: ImportPlanCounts;
}

function normalizeUrlForCompare(url: string): string {
  try {
    return getDomain(url).toLowerCase() + new URL(url).pathname.replace(/\/+$/, "");
  } catch {
    return url.trim().toLowerCase();
  }
}

function classifyItem(backupItem: BackupLibraryItem, currentItems: LibraryItem[]): { classification: ItemClassification; existingItemId?: string } {
  if (backupItem.type === "website") {
    const targetUrl = backupItem.url ? normalizeUrlForCompare(backupItem.url) : null;
    if (!targetUrl) return { classification: "new" };
    const match = currentItems.find((item) => item.type === "website" && normalizeUrlForCompare(item.url) === targetUrl);
    return match ? { classification: "already_present", existingItemId: match.id } : { classification: "new" };
  }

  const currentMedia = currentItems.filter(isMediaItem).filter((item) => item.type === backupItem.type);

  if (backupItem.catalogSource) {
    const catalogMatch = currentMedia.find(
      (item) => item.catalogSource && item.catalogSource.provider === backupItem.catalogSource!.provider && item.catalogSource.externalId === backupItem.catalogSource!.externalId,
    );
    if (catalogMatch) return { classification: "already_present", existingItemId: catalogMatch.id };
  }

  const titleKey = normalizeTitleForMatching(backupItem.title);
  const titleMatch = currentMedia.find((item) => {
    if (normalizeTitleForMatching(item.title) !== titleKey) return false;
    // Withhold entirely on a conflicting catalog identity — same
    // reasoning as duplicate-detection.ts's conflictingCatalogSource:
    // same title but a strong signal they're different real-world works.
    if (backupItem.catalogSource && item.catalogSource) {
      return item.catalogSource.provider === backupItem.catalogSource.provider && item.catalogSource.externalId === backupItem.catalogSource.externalId;
    }
    return true;
  });
  if (titleMatch) return { classification: "possible_duplicate" };

  return { classification: "new" };
}

function classifyCollection(backupCollection: BackupCollection, currentCollections: Collection[]): ClassifiedCollection {
  const key = backupCollection.name.trim().toLowerCase();
  const existing = currentCollections.find((collection) => collection.name.trim().toLowerCase() === key);
  return existing
    ? { backupCollection, action: "reuse", existingCollectionId: existing.id }
    : { backupCollection, action: "create" };
}

export interface BuildImportPlanOptions {
  /** Section 30's checkbox — default OFF. When true, possible-duplicate items are created as genuinely separate new items (never merged/mapped). */
  includePossibleDuplicates: boolean;
}

export function buildImportPlan(
  backup: ValidatedBackup,
  currentItems: LibraryItem[],
  currentCollections: Collection[],
  options: BuildImportPlanOptions,
): ImportPlan {
  const items: ClassifiedItem[] = backup.libraryItems.map((backupItem) => {
    const { classification, existingItemId } = classifyItem(backupItem, currentItems);
    const action: "create" | "skip" =
      classification === "new" || (classification === "possible_duplicate" && options.includePossibleDuplicates) ? "create" : "skip";
    return { backupItem, classification, action, existingItemId };
  });

  const resolvedItemIds = new Set(items.filter((entry) => entry.action === "create").map((entry) => entry.backupItem.backupItemId));
  const mappedExistingIds = new Map(
    items.filter((entry) => entry.classification === "already_present").map((entry) => [entry.backupItem.backupItemId, entry.existingItemId!]),
  );
  const attachableItemIds = new Set([...resolvedItemIds, ...mappedExistingIds.keys()]);

  const collections: ClassifiedCollection[] = backup.collections.map((backupCollection) => classifyCollection(backupCollection, currentCollections));

  const memberships: CollectionMembershipPlan[] = [];
  for (const backupCollection of backup.collections) {
    for (const backupItemId of backupCollection.itemIds) {
      if (attachableItemIds.has(backupItemId)) {
        memberships.push({ backupCollectionId: backupCollection.backupCollectionId, backupItemId });
      }
    }
  }

  const activityToImport = backup.activityEvents.filter((event) => resolvedItemIds.has(event.itemId));

  const itemsPossibleDuplicateTotal = items.filter((entry) => entry.classification === "possible_duplicate").length;
  const counts: ImportPlanCounts = {
    itemsNew: items.filter((entry) => entry.classification === "new").length,
    itemsAlreadyPresent: items.filter((entry) => entry.classification === "already_present").length,
    itemsPossibleDuplicate: itemsPossibleDuplicateTotal,
    itemsPossibleDuplicateIncluded: items.filter((entry) => entry.classification === "possible_duplicate" && entry.action === "create").length,
    collectionsNew: collections.filter((entry) => entry.action === "create").length,
    collectionsReuse: collections.filter((entry) => entry.action === "reuse").length,
    activityImport: activityToImport.length,
    activitySkipped: backup.activityEvents.length - activityToImport.length,
  };

  return { exportedAt: backup.exportedAt, items, collections, memberships, activityToImport, counts };
}
