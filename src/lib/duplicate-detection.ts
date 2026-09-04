import type { LibraryItem, MediaItem } from "@/types/library-item";
import { isMediaItem } from "@/lib/item-detail";
import { normalizeTitleForMatching } from "@/lib/title-normalization";

/**
 * Stage 27 — safe, conservative duplicate SUGGESTION (never automatic
 * merging — see README "Safe Duplicate Detection & Manual Merge"). Runs
 * entirely client-side over the items the current view already has (no new
 * server queries, no N² fetching — see the module's own performance note
 * below), grouping by two signals only:
 *
 *   - "catalog_match" (strong): the same media type AND the same
 *     catalogSource.provider + externalId. Titles may differ — this is
 *     exactly Frieren / "Frieren: Beyond Journey's End" sharing one AniList
 *     id (see README "Authoritative catalog duplicates").
 *   - "title_match": the same media type AND the exact normalized title —
 *     reusing normalizeTitleForMatching verbatim from the same shared
 *     module Smart Auto-Link uses (lib/title-normalization.ts) rather
 *     than a second, subtly-different implementation. "Lord of Mysteries"
 *     and "Lord of the Mysteries" are
 *     deliberately DIFFERENT keys — no fuzzy/partial/Levenshtein matching
 *     is used anywhere in this module.
 *
 * A title match between two items whose catalogSource IDs actively
 * CONFLICT (both set, and different) is never unioned — same title, but a
 * strong signal they're different real-world works, so this is withheld
 * from suggestion entirely (see README "Conflicting catalog identities").
 * The rare transitive-bridge case (three same-titled items where a third,
 * catalog-source-less item sits "between" two conflicting ones) is a known,
 * documented limitation of this simple pairwise check — see the README.
 * It only ever affects which items get grouped together for the user's
 * REVIEW; the merge action itself (library-merge.ts) independently
 * re-checks every pair it's actually asked to merge and refuses a
 * genuinely conflicting one regardless of how the suggestion grouped it.
 */

export type DuplicateConfidence = "catalog_match" | "title_match";

export interface DuplicateGroup {
  /** Stable within one render — not persisted, not an id of anything in the database. */
  key: string;
  mediaType: MediaItem["type"];
  confidence: DuplicateConfidence;
  items: MediaItem[];
}

function catalogKey(item: MediaItem): string | null {
  if (!item.catalogSource) return null;
  return `${item.type}::${item.catalogSource.provider}::${item.catalogSource.externalId}`;
}

function titleKey(item: MediaItem): string {
  return `${item.type}::${normalizeTitleForMatching(item.title)}`;
}

/** Two items are a conflicting pair when both have an authoritative catalog identity and it differs — see README "Conflicting catalog identities". Never true when either side simply lacks a catalogSource. */
function conflictingCatalogSource(a: MediaItem, b: MediaItem): boolean {
  if (!a.catalogSource || !b.catalogSource) return false;
  return a.catalogSource.provider !== b.catalogSource.provider || a.catalogSource.externalId !== b.catalogSource.externalId;
}

function pushToGroup<K>(map: Map<K, MediaItem[]>, key: K, item: MediaItem): void {
  const existing = map.get(key);
  if (existing) existing.push(item);
  else map.set(key, [item]);
}

/** A tiny disjoint-set (union-find) over item ids — connects items that share EITHER signal into one group, per README "Duplicate grouping" (never pairwise A↔B, A↔C, B↔C explosion). */
class DisjointSet {
  private readonly parent = new Map<string, string>();

  add(id: string): void {
    if (!this.parent.has(id)) this.parent.set(id, id);
  }

  find(id: string): string {
    let root = id;
    while (this.parent.get(root) !== root) root = this.parent.get(root) as string;
    let current = id;
    while (this.parent.get(current) !== root) {
      const next = this.parent.get(current) as string;
      this.parent.set(current, root);
      current = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parent.set(rootA, rootB);
  }
}

/** True when at least two items in the group actually share a catalog key — distinguishes "high confidence" groups from plain title-only matches for display (see README "Duplicate confidence display"). */
function groupHasCatalogMatch(items: MediaItem[]): boolean {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = catalogKey(item);
    if (!key) continue;
    const count = (counts.get(key) ?? 0) + 1;
    if (count >= 2) return true;
    counts.set(key, count);
  }
  return false;
}

/**
 * Groups a library into potential-duplicate clusters. Only ever called
 * with items already available to the current view (see README
 * "Duplicate detection performance") — this is a pure, synchronous
 * function with no I/O, safe to run on every render behind a `useMemo`.
 * Website items and the generic placeholder type are never candidates —
 * duplicate merging is a media-tracking concept (progress, catalog
 * identity), which those types don't have.
 */
export function findDuplicateGroups(items: LibraryItem[]): DuplicateGroup[] {
  const mediaItems = items.filter(isMediaItem);
  const sets = new DisjointSet();
  mediaItems.forEach((item) => sets.add(item.id));

  const byCatalog = new Map<string, MediaItem[]>();
  mediaItems.forEach((item) => {
    const key = catalogKey(item);
    if (key) pushToGroup(byCatalog, key, item);
  });
  byCatalog.forEach((group) => {
    for (let i = 1; i < group.length; i++) sets.union(group[0].id, group[i].id);
  });

  const byTitle = new Map<string, MediaItem[]>();
  mediaItems.forEach((item) => pushToGroup(byTitle, titleKey(item), item));
  byTitle.forEach((group) => {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        if (conflictingCatalogSource(group[i], group[j])) continue;
        sets.union(group[i].id, group[j].id);
      }
    }
  });

  const components = new Map<string, MediaItem[]>();
  mediaItems.forEach((item) => pushToGroup(components, sets.find(item.id), item));

  const groups: DuplicateGroup[] = [];
  components.forEach((groupItems, root) => {
    if (groupItems.length < 2) return;
    groups.push({
      key: root,
      mediaType: groupItems[0].type,
      confidence: groupHasCatalogMatch(groupItems) ? "catalog_match" : "title_match",
      items: [...groupItems].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    });
  });

  return groups.sort((a, b) => a.items[0].title.localeCompare(b.items[0].title, undefined, { sensitivity: "base" }));
}
