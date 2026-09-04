"use client";

import { useState } from "react";
import type { MediaItem } from "@/types/library-item";
import { ITEM_TYPE_LABELS } from "@/types/library-item";
import type { Collection } from "@/types/collection";
import type { DuplicateGroup } from "@/lib/duplicate-detection";
import { computeMergedLibraryItem, MERGE_BLOCK_REASON_LABELS } from "@/lib/library-merge";
import { getProgressInfo, getStatusLabel } from "@/lib/tracking";
import { formatDate, getProviderLabel } from "@/lib/item-detail";
import { Dialog } from "@/components/Dialog";
import { CheckIcon } from "@/components/icons";
import { cn } from "@/lib/utils";

interface DuplicateMergeDialogProps {
  group: DuplicateGroup;
  collections: Collection[];
  onMerge: (survivorId: string, duplicateId: string) => Promise<{ ok: boolean; errorText?: string }>;
  onClose: () => void;
}

/** A modest, non-scientific "which copy looks more complete" heuristic, used only to pre-select a recommended radio option — the user always sees and can override it (Section 7: never a silent automatic choice). */
function completenessScore(item: MediaItem): number {
  let score = 0;
  if (item.description) score += 1;
  if (item.imageUrl) score += 1;
  if (item.catalogSource) score += 3;
  if (item.rating !== undefined) score += 1;
  if ("genres" in item && item.genres?.length) score += 1;
  return score;
}

function collectionCountFor(itemId: string, collections: Collection[]): number {
  return collections.filter((collection) => collection.itemIds.includes(itemId)).length;
}

/**
 * Reviews and merges exactly one pair from a duplicate group — the two
 * oldest items (group.items is sorted by createdAt). If a group has more
 * than two members, merging this pair first and re-opening "Review" again
 * for what's left is the intended flow (see README "Duplicate review UI"
 * for why this stays deliberately pairwise rather than an N-way merge
 * workflow). Callers should render this with `key={group.key}` so
 * selecting a different group always starts from fresh internal state.
 */
export function DuplicateMergeDialog({ group, collections, onMerge, onClose }: DuplicateMergeDialogProps) {
  const [itemA, itemB] = group.items;
  const recommended = completenessScore(itemA) >= completenessScore(itemB) ? itemA.id : itemB.id;
  const [survivorId, setSurvivorId] = useState<string>(recommended);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const survivor = survivorId === itemA.id ? itemA : itemB;
  const duplicate = survivorId === itemA.id ? itemB : itemA;
  const computation = computeMergedLibraryItem(survivor, duplicate);

  async function handleMerge() {
    setBusy(true);
    setError(undefined);
    const result = await onMerge(survivor.id, duplicate.id);
    setBusy(false);
    if (!result.ok) {
      setError(result.errorText ?? "Couldn't merge these items. Try again.");
      return;
    }
    onClose();
  }

  return (
    <Dialog isOpen onClose={onClose} title="Review possible duplicate" widthClassName="max-w-lg">
      <p className="mb-4 text-sm text-muted-foreground">
        {group.confidence === "catalog_match"
          ? "These items are linked to the same catalog entry."
          : "These items have the exact same title and type."}{" "}
        Choose which one to keep.
      </p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {[itemA, itemB].map((item) => {
          const selected = survivorId === item.id;
          const progress = getProgressInfo(item);
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setSurvivorId(item.id)}
              aria-pressed={selected}
              className={cn(
                "flex flex-col gap-1.5 rounded-md border p-3 text-left transition-colors",
                selected ? "border-accent bg-accent/5" : "border-border hover:border-foreground/30",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground/70">
                  {item.id === recommended ? "Recommended" : "Keep this"}
                </span>
                {selected && <CheckIcon width={14} height={14} className="shrink-0 text-accent" />}
              </div>
              <p className="truncate text-sm font-medium text-foreground">{item.title}</p>
              <p className="text-xs text-muted-foreground">{ITEM_TYPE_LABELS[item.type]}</p>
              <p className="text-xs text-muted-foreground">{getStatusLabel(item)}</p>
              {progress && <p className="text-xs text-muted-foreground">{progress.text}</p>}
              {item.rating !== undefined && <p className="text-xs text-muted-foreground">{item.rating} / 10</p>}
              {item.catalogSource && (
                <p className="text-xs text-muted-foreground">{getProviderLabel(item.catalogSource.provider)}</p>
              )}
              <p className="text-xs text-muted-foreground">{collectionCountFor(item.id, collections)} collection(s)</p>
              {formatDate(item.createdAt) && <p className="text-xs text-muted-foreground">Added {formatDate(item.createdAt)}</p>}
            </button>
          );
        })}
      </div>

      <div className="mt-4 rounded-md border border-border bg-background p-3">
        {computation.status === "blocked" ? (
          <p className="text-sm text-danger">{MERGE_BLOCK_REASON_LABELS[computation.reason]}</p>
        ) : (
          <>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground/70">Merge into: {survivor.title}</p>
            <p className="mt-1.5 text-sm text-foreground">Will preserve:</p>
            <ul className="mt-1 space-y-0.5 text-sm text-muted-foreground">
              {getProgressInfo(computation.merged) && <li>Progress: {getProgressInfo(computation.merged)?.text}</li>}
              <li>Tags: {computation.merged.tags.length}</li>
              <li>Tracking sources: preserved</li>
              <li>Collections: preserved</li>
              <li>Activity history: preserved</li>
            </ul>
            <p className="mt-2 text-xs text-muted-foreground">
              &quot;{duplicate.title}&quot; will be deleted after everything above has been moved.
            </p>
          </>
        )}
      </div>

      {error && <p className="mt-3 text-sm text-danger">{error}</p>}

      <div className="mt-4 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-border px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleMerge}
          disabled={busy || computation.status === "blocked"}
          className="rounded-md bg-foreground px-3.5 py-2 text-sm font-medium text-background transition-colors hover:bg-foreground/85 disabled:opacity-60"
        >
          {busy ? "Merging…" : "Merge Items"}
        </button>
      </div>
    </Dialog>
  );
}
