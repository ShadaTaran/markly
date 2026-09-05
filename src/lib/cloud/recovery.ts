import type { SupabaseClient } from "@supabase/supabase-js";
import type { RecoveryActionType } from "@/lib/library-recovery";

export type DeleteRecoveryStatus = "deleted" | "not_found" | "unauthorized";

export interface DeleteRecoveryResult {
  status: DeleteRecoveryStatus;
  /** Present only when status is "deleted". */
  recoveryId?: string;
}

const DELETE_STATUSES: readonly DeleteRecoveryStatus[] = ["deleted", "not_found", "unauthorized"];

function parseDeleteResult(data: unknown): DeleteRecoveryResult | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  const status = record.status;
  if (typeof status !== "string" || !(DELETE_STATUSES as readonly string[]).includes(status)) return null;
  const recoveryId = typeof record.recoveryId === "string" ? record.recoveryId : undefined;
  return { status: status as DeleteRecoveryStatus, recoveryId };
}

/**
 * Calls delete_library_item_with_recovery (see
 * supabase/migrations/0010_stage28_library_recovery.sql) — the item's row,
 * its collection memberships, its Activity history, and the ids of any
 * TrackingSources pointing at it are all snapshotted in the same
 * transaction as the delete itself, so a crash between "delete" and
 * "remember what was deleted" can't happen. Session-authenticated;
 * ownership is enforced inside the function via auth.uid().
 */
export async function deleteLibraryItemWithRecovery(supabase: SupabaseClient, itemId: string): Promise<DeleteRecoveryResult> {
  const { data, error } = await supabase.rpc("delete_library_item_with_recovery", { p_item_id: itemId });
  if (error) throw error;
  const result = parseDeleteResult(data);
  if (!result) throw new Error("delete_library_item_with_recovery returned an unexpected shape");
  return result;
}

export type UndoRecoveryStatus = "recovered" | "not_found" | "expired" | "recovery_conflict" | "unauthorized" | "invalid_action";

export interface UndoRecoveryResult {
  status: UndoRecoveryStatus;
  /** Present only when status is "recovery_conflict" — a machine-readable reason (e.g. "survivor_changed", "source_claimed_elsewhere"); see recovery-orchestration.ts's conflictMessage for the plain-language copy shown to users. */
  reason?: string;
  actionType?: RecoveryActionType;
}

const UNDO_STATUSES: readonly UndoRecoveryStatus[] = [
  "recovered",
  "not_found",
  "expired",
  "recovery_conflict",
  "unauthorized",
  "invalid_action",
];

function parseUndoResult(data: unknown): UndoRecoveryResult | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  const status = record.status;
  if (typeof status !== "string" || !(UNDO_STATUSES as readonly string[]).includes(status)) return null;
  return {
    status: status as UndoRecoveryStatus,
    reason: typeof record.reason === "string" ? record.reason : undefined,
    actionType: record.actionType === "delete_item" || record.actionType === "merge_items" ? record.actionType : undefined,
  };
}

/**
 * Calls undo_library_recovery. The RPC re-validates everything against the
 * live, row-locked database before restoring anything — it never trusts
 * that the recovery row's snapshot still reflects reality just because the
 * client is asking to undo it. See the migration's doc comment for exactly
 * what it checks per action type.
 */
export async function undoLibraryRecovery(supabase: SupabaseClient, recoveryId: string): Promise<UndoRecoveryResult> {
  const { data, error } = await supabase.rpc("undo_library_recovery", { p_recovery_id: recoveryId });
  if (error) throw error;
  const result = parseUndoResult(data);
  if (!result) throw new Error("undo_library_recovery returned an unexpected shape");
  return result;
}

export interface RecoveryActionSummary {
  id: string;
  actionType: RecoveryActionType;
  title: string;
  createdAt: string;
  expiresAt: string;
}

interface RecoveryActionRow {
  id: string;
  action_type: string;
  payload: Record<string, unknown> | null;
  created_at: string;
  expires_at: string;
}

function titleFromPayload(actionType: string, payload: Record<string, unknown>): string {
  if (actionType === "delete_item") {
    const item = payload.item as Record<string, unknown> | undefined;
    return typeof item?.title === "string" ? item.title : "Untitled item";
  }
  const survivor = (payload.survivorPostMergeExpected ?? payload.survivorPreMerge) as Record<string, unknown> | undefined;
  return typeof survivor?.title === "string" ? survivor.title : "Untitled item";
}

/**
 * Lists this user's still-usable recovery actions for the Settings
 * "Recently changed" surface (Section 31 — not a full Trash page). Reads
 * the table directly rather than deriving anything from local app state,
 * since a recovery row can outlive the page/tab that created it.
 */
export async function fetchRecoveryActions(supabase: SupabaseClient, userId: string): Promise<RecoveryActionSummary[]> {
  const { data, error } = await supabase
    .from("library_recovery_actions")
    .select("id, action_type, payload, created_at, expires_at")
    .eq("user_id", userId)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .returns<RecoveryActionRow[]>();
  if (error) throw error;

  return (data ?? []).map((row) => ({
    id: row.id,
    actionType: row.action_type === "merge_items" ? "merge_items" : "delete_item",
    title: titleFromPayload(row.action_type, row.payload ?? {}),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  }));
}
