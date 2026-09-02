import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { LibraryItemRow } from "@/lib/supabase/database.types";
import type { MediaItem } from "@/types/library-item";
import { isMediaItem } from "@/lib/item-detail";
import { fromLibraryItemRow, toLibraryItemRow } from "@/lib/cloud/library-items";
import type { DetectedMetadata } from "@/lib/extension/detected-metadata";

/**
 * Fills in empty metadata fields on an already-linked LibraryItem from a
 * detection's optional enrichment metadata — conservative "fill empty
 * fields only" merge (see README "Metadata Enrichment" for the full
 * priority reasoning): a field that already holds a meaningful value
 * (user-entered, catalog-imported, or filled by an earlier detection) is
 * never touched. Never touches progress/status — that's
 * applyDetectionToItem's job, via migration 0004's atomic RPC. This is a
 * separate, much lower-stakes operation: a race here just means two
 * near-simultaneous detections independently compute and write the same
 * already-empty-field fill, converging on an identical result — not a
 * duplicate side effect the way a progress race would be, so no
 * row-locking RPC is needed for it. Silent — never creates an Activity
 * event. Errors here are the caller's problem to swallow; enrichment must
 * never fail a request that already carries a real progress update.
 *
 * `metadata` may be null (a detection with nothing safely extractable) —
 * the readingFormat suggestion below doesn't need it to be present, so
 * this is still worth calling even then, not gated by the caller.
 */
export async function enrichLibraryItemIfSparse(
  admin: SupabaseClient,
  userId: string,
  itemId: string,
  mediaType: MediaItem["type"],
  metadata: DetectedMetadata | null,
): Promise<void> {
  const { data, error } = await admin.from("library_items").select("*").eq("id", itemId).eq("user_id", userId).returns<LibraryItemRow[]>();
  if (error) throw error;

  const row = data?.[0];
  if (!row) return;

  let current: MediaItem;
  try {
    const parsed = fromLibraryItemRow(row);
    if (!isMediaItem(parsed) || parsed.type !== mediaType) return;
    current = parsed;
  } catch {
    return;
  }

  const patched: MediaItem = { ...current };
  let changed = false;

  if (!patched.imageUrl && metadata?.coverUrl) {
    patched.imageUrl = metadata.coverUrl;
    changed = true;
  }
  if (!patched.sourceUrl && metadata?.workUrl) {
    patched.sourceUrl = metadata.workUrl;
    changed = true;
  }
  if (!patched.description && metadata?.description) {
    patched.description = metadata.description;
    changed = true;
  }
  if ((patched.type === "novel" || patched.type === "manga") && (!patched.authors || patched.authors.length === 0) && metadata?.authors) {
    patched.authors = metadata.authors;
    changed = true;
  }
  if ("genres" in patched && (!patched.genres || patched.genres.length === 0) && metadata?.genres) {
    patched.genres = metadata.genres;
    changed = true;
  }
  // Format is a suggestion tied to "this is a chapter-based detection
  // with nothing catalog-authoritative behind it yet" — the exact same
  // condition Stage 20 already suggests web_novel under for a brand-new
  // item (see lib/extension/detected-item.ts) — not to whether any other
  // enrichment field happened to be found this time. Skipped for a
  // catalog-backed item even if its format is empty (a future catalog
  // provider that doesn't set one shouldn't get overridden by a guess).
  if (patched.type === "novel" && !patched.readingFormat && !patched.catalogSource) {
    patched.readingFormat = "web_novel";
    changed = true;
  }

  if (!changed) return;

  patched.updatedAt = new Date().toISOString();
  const { error: updateError } = await admin.from("library_items").upsert(toLibraryItemRow(patched, userId));
  if (updateError) throw updateError;
}
