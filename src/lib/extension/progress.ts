import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MediaItem } from "@/types/library-item";

export type ProgressApplyStatus =
  | "updated"
  | "unchanged"
  | "behind_current_progress"
  | "incompatible_media_type"
  | "item_not_found";

export interface ProgressApplyResult {
  status: ProgressApplyStatus;
  currentValue?: number;
}

type ProgressField = "currentEpisode" | "currentChapter" | "progressValue" | "playtimeHours";

/** The one LibraryItem field a given (mediaType, progressKind) pair is allowed to touch — deliberately narrow, never a generic field name from the request. Purely a static lookup (no row state), so it's safe to resolve here rather than inside the transaction below. */
function resolveProgressField(mediaType: MediaItem["type"], progressKind: string): ProgressField | null {
  if ((mediaType === "anime" || mediaType === "series") && progressKind === "episode") return "currentEpisode";
  if (mediaType === "manga" && progressKind === "chapter") return "currentChapter";
  if (mediaType === "novel" && (progressKind === "chapter" || progressKind === "page" || progressKind === "percent")) return "progressValue";
  if (mediaType === "game" && progressKind === "playtime") return "playtimeHours";
  return null;
}

interface ApplyProgressRpcResult {
  status: ProgressApplyStatus;
  currentValue?: number;
  statusChanged?: boolean;
}

const PROGRESS_APPLY_STATUSES: readonly ProgressApplyStatus[] = [
  "updated",
  "unchanged",
  "behind_current_progress",
  "incompatible_media_type",
  "item_not_found",
];

/** Validates the RPC's jsonb return value at runtime rather than fighting postgrest-js's generic inference (which, for this project's deliberately untyped SupabaseClient — see database.types.ts — defaults an RPC call's result to an array shape no `.returns()`/`.overrideTypes()` override cleanly escapes). */
function parseApplyProgressResult(data: unknown): ApplyProgressRpcResult | null {
  if (!data || typeof data !== "object") return null;
  const candidate = data as Record<string, unknown>;
  const status = candidate.status;
  if (typeof status !== "string" || !(PROGRESS_APPLY_STATUSES as readonly string[]).includes(status)) return null;

  const currentValue = typeof candidate.currentValue === "number" ? candidate.currentValue : undefined;
  const statusChanged = typeof candidate.statusChanged === "boolean" ? candidate.statusChanged : undefined;
  return { status: status as ProgressApplyStatus, currentValue, statusChanged };
}

/**
 * Applies one normalized detection to an already-linked LibraryItem.
 * Monotonic by design: only ever advances progress (rereading an old
 * chapter must never roll Markly backward), and treats an identical value
 * as a no-op.
 *
 * The read, the compare, the LibraryItem write, and the Activity insert(s)
 * all happen inside a single database transaction — the Postgres function
 * apply_extension_progress (see
 * supabase/migrations/0004_stage18_atomic_progress.sql), which locks the
 * target row with `select ... for update` before comparing anything. This
 * is what makes the operation safe when multiple identical detections
 * arrive concurrently (extension retries, a duplicate racing a fresh
 * request, or multiple server instances): only the request that actually
 * observes and wins the compare-and-set writes anything or creates
 * Activity rows. Every other concurrent request for the same source
 * blocks briefly, then sees the already-updated value and returns
 * "unchanged" having written nothing. The extension's own service-worker
 * dedup (lastSentValue in background/service-worker.ts) is only a
 * network-efficiency optimization on top of this — it is never the thing
 * making duplicate writes impossible; this function is.
 */
export async function applyDetectionToItem(
  admin: SupabaseClient,
  userId: string,
  itemId: string,
  mediaType: MediaItem["type"],
  progressKind: string,
  progressValue: number,
): Promise<ProgressApplyResult> {
  const field = resolveProgressField(mediaType, progressKind);
  if (!field) {
    return { status: "incompatible_media_type" };
  }

  const { data, error } = await admin.rpc("apply_extension_progress", {
    p_user_id: userId,
    p_item_id: itemId,
    p_media_type: mediaType,
    p_progress_field: field,
    p_progress_kind: progressKind,
    p_new_value: progressValue,
  });
  if (error) throw error;

  const result = parseApplyProgressResult(data);
  if (!result) throw new Error("apply_extension_progress returned an unexpected shape");

  return { status: result.status, currentValue: result.currentValue };
}
