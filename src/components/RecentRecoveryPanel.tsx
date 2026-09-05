"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { useLibraryItems } from "@/hooks/useLibraryItems";
import { useCollections } from "@/hooks/useCollections";
import { useActivity } from "@/hooks/useActivity";
import { getSupabaseClient } from "@/lib/supabase/client";
import { fetchRecoveryActions, type RecoveryActionSummary } from "@/lib/cloud/recovery";
import { loadRecoveryActions } from "@/lib/local-recovery-storage";
import { undoRecoveryAction } from "@/lib/recovery-orchestration";
import { formatDate } from "@/lib/item-detail";
import { DataErrorBanner } from "@/components/DataStatus";

/**
 * Stage 28 — "Recently changed" surface (Section 31): a short, refresh-
 * persistent list of the current user's still-undoable Delete/Merge
 * actions, deliberately not a full Trash page — entries here age out on
 * their own after 15 minutes, there's nothing to browse or restore beyond
 * that window.
 */
export function RecentRecoveryPanel() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const activity = useActivity(userId);
  const library = useLibraryItems([], activity.logEvent, userId);
  const collectionsStore = useCollections(library.items, library.isHydrated, userId);

  const [actions, setActions] = useState<RecoveryActionSummary[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (userId) {
      const supabase = getSupabaseClient();
      if (!supabase) {
        setLoadFailed(true);
        return;
      }
      try {
        setActions(await fetchRecoveryActions(supabase, userId));
        setLoadFailed(false);
      } catch {
        setLoadFailed(true);
      }
      return;
    }

    setActions(
      loadRecoveryActions().map((entry) => ({
        id: entry.id,
        actionType: entry.actionType,
        title: entry.title,
        createdAt: entry.createdAt,
        expiresAt: entry.expiresAt,
      })),
    );
  }, [userId]);

  useEffect(() => {
    if (userId && !library.isHydrated) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time fetch from an external store (localStorage or Supabase) whenever userId/hydration changes; the value can't be derived during render since both sources require an effect (localStorage isn't available at SSR time, and the Supabase fetch is async).
    load();
  }, [userId, library.isHydrated, load]);

  async function handleUndo(id: string) {
    setFeedback(null);
    setPendingId(id);
    const result = await undoRecoveryAction(id, userId, library, collectionsStore, activity);
    setPendingId(null);
    setFeedback(result.message);
    load();
  }

  if (userId && !library.isHydrated) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Deleting or merging an item here stays undoable for 15 minutes — after that, the change is final.
      </p>

      {loadFailed && <DataErrorBanner message="Unable to load recent actions." onRetry={load} />}
      {feedback && <p className="text-sm text-muted-foreground">{feedback}</p>}

      {actions && actions.length === 0 && !loadFailed && (
        <p className="rounded-md border border-border bg-surface p-3 text-sm text-muted-foreground">
          Nothing recent to undo.
        </p>
      )}

      {actions && actions.length > 0 && (
        <ul className="space-y-2">
          {actions.map((action) => (
            <li
              key={action.id}
              className="flex items-center justify-between gap-3 rounded-md border border-border bg-surface p-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">{action.title}</p>
                <p className="text-xs text-muted-foreground">
                  {action.actionType === "delete_item" ? "Deleted" : "Merged"}
                  {formatDate(action.createdAt) ? ` · ${formatDate(action.createdAt)}` : ""}
                </p>
              </div>
              <button
                type="button"
                onClick={() => handleUndo(action.id)}
                disabled={pendingId === action.id}
                className="shrink-0 rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-surface-hover disabled:opacity-50"
              >
                {pendingId === action.id ? "Undoing…" : "Undo"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
