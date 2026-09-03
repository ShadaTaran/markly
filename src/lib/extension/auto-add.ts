import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MediaItem } from "@/types/library-item";
import type { TrackingSourceSummary } from "@/lib/extension/types";
import { buildDetectedMediaInput } from "@/lib/extension/detected-item";
import { createMediaItem } from "@/lib/library-items";
import { toLibraryItemRow } from "@/lib/cloud/library-items";
import { generateId } from "@/lib/utils";
import { logSanitizedError } from "@/lib/extension/log-error";

export type AutoAddOutcome =
  | { kind: "created"; libraryItemId: string }
  | { kind: "linked_existing"; libraryItemId: string }
  | { kind: "already_linked"; libraryItemId: string }
  | { kind: "ambiguous" }
  | { kind: "source_not_found" }
  | { kind: "invalid_title" };

const AUTO_ADD_STATUSES: readonly AutoAddOutcome["kind"][] = [
  "created",
  "linked_existing",
  "already_linked",
  "ambiguous",
  "source_not_found",
  "invalid_title",
];

function parseAutoAddResult(data: unknown): AutoAddOutcome | null {
  if (!data || typeof data !== "object") return null;
  const candidate = data as Record<string, unknown>;
  const status = candidate.status;
  if (typeof status !== "string" || !(AUTO_ADD_STATUSES as readonly string[]).includes(status)) return null;

  if (status === "created" || status === "linked_existing" || status === "already_linked") {
    const libraryItemId = candidate.libraryItemId;
    if (typeof libraryItemId !== "string") return null;
    return { kind: status, libraryItemId };
  }
  return { kind: status as "ambiguous" | "source_not_found" | "invalid_title" };
}

/**
 * Attempts to atomically create-and-link a brand-new LibraryItem for a
 * detected source that Smart Auto-Link already found no match for. Only
 * ever called when the caller (route.ts) has already confirmed: the
 * device has auto-add enabled, no tracking_sources mapping exists yet, and
 * attemptSmartAutoLink returned "no_match" (never "ambiguous" — see
 * lib/extension/auto-link.ts; that check happens before this function is
 * invoked and is not repeated here). All of the actual concurrency safety
 * — exactly-once creation under N simultaneous identical first detections,
 * and the narrower cross-source-same-title race — lives in the database
 * function this calls (see supabase/migrations/
 * 0005_stage22_auto_add.sql's auto_add_and_link_source for the two-lock
 * design). This function's own job is just building the row to insert,
 * reusing buildDetectedMediaInput/createMediaItem/toLibraryItemRow so a
 * server-triggered auto-add produces an identical row shape to a manual
 * "Add & Track" click (readingFormat suggestion, detected-metadata fill,
 * initial status/progress — nothing duplicated or reimplemented here).
 */
export async function attemptAutoAdd(
  admin: SupabaseClient,
  userId: string,
  sourceId: string,
  mediaType: MediaItem["type"],
  source: TrackingSourceSummary,
): Promise<AutoAddOutcome> {
  const mediaInput = buildDetectedMediaInput(source);
  // id/createdAt are discarded below — the database function generates its
  // own id and created_at (the actual commit time, which is what matters
  // once this is racing against concurrent requests), never these.
  const draft = createMediaItem(mediaType, generateId(), new Date().toISOString(), mediaInput);
  const row = toLibraryItemRow(draft, userId);

  const { data, error } = await admin.rpc("auto_add_and_link_source", {
    p_user_id: userId,
    p_source_id: sourceId,
    p_media_type: mediaType,
    p_row: row,
  });
  if (error) {
    logSanitizedError("[extension:auto-add] atomic auto-add failed", error);
    throw error;
  }

  const result = parseAutoAddResult(data);
  if (!result) throw new Error("auto_add_and_link_source returned an unexpected shape");
  return result;
}
