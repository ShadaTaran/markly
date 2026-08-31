"use client";

import { useState, type FormEvent } from "react";
import type { GameItem, MediaItem, NovelItem, TrackingStatus } from "@/types/library-item";
import type { TrackingUpdatePatch } from "@/hooks/useLibraryItems";
import { getProgressInfo, getStatusLabel, TRACKING_STATUS_OPTIONS } from "@/lib/tracking";
import { ProgressBar } from "@/components/ProgressBar";
import { inputClass } from "@/components/FormField";
import { PencilIcon } from "@/components/icons";

interface ItemTrackingSectionProps {
  item: MediaItem;
  onIncrementProgress: (item: MediaItem) => void;
  onAdjustPlaytime: (item: GameItem, delta: number) => void;
  onUpdateNovelProgress: (item: NovelItem, value: number) => void;
  onSaveTracking: (item: MediaItem, patch: TrackingUpdatePatch) => void;
}

export function ItemTrackingSection({
  item,
  onIncrementProgress,
  onAdjustPlaytime,
  onUpdateNovelProgress,
  onSaveTracking,
}: ItemTrackingSectionProps) {
  const [editing, setEditing] = useState(false);
  const [announcement, setAnnouncement] = useState("");

  const statusLabel = getStatusLabel(item);
  const progress = getProgressInfo(item);
  // Movie has no numeric progress concept at all — no row, no controls.
  const hasProgress = item.type !== "movie";
  const progressLabel = item.type === "game" ? "Playtime" : "Progress";

  function handleSave(patch: TrackingUpdatePatch) {
    onSaveTracking(item, patch);
    setEditing(false);
    setAnnouncement("Tracking updated");
  }

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
          Your Tracking
        </p>
        {!editing && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            aria-label={`Edit tracking for ${item.title}`}
            className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <PencilIcon width={14} height={14} />
          </button>
        )}
      </div>

      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {editing ? (
        <TrackingEditForm item={item} onSave={handleSave} onCancel={() => setEditing(false)} />
      ) : (
        <dl className="space-y-3">
          <div>
            <dt className="text-xs text-muted-foreground">Status</dt>
            <dd className="text-sm font-medium text-foreground">{statusLabel}</dd>
          </div>

          {hasProgress && (
            <div>
              <dt className="text-xs text-muted-foreground">{progressLabel}</dt>
              <div className="flex items-center justify-between gap-3">
                {progress ? (
                  <dd className="text-sm font-medium text-foreground">{progress.text}</dd>
                ) : (
                  <dd className="text-sm text-muted-foreground">No progress yet</dd>
                )}

                <div className="flex shrink-0 gap-1">
                  {(item.type === "anime" || item.type === "series") && (
                    <GhostButton
                      label="+1"
                      ariaLabel={`Increment ${item.title} episode progress`}
                      onClick={() => {
                        onIncrementProgress(item);
                        setAnnouncement("Episode progress updated");
                      }}
                    />
                  )}

                  {item.type === "manga" && (
                    <GhostButton
                      label="+1"
                      ariaLabel={`Add one chapter to ${item.title}`}
                      onClick={() => {
                        onIncrementProgress(item);
                        setAnnouncement("Chapter progress updated");
                      }}
                    />
                  )}

                  {/* Page/percent progress has no obvious "+1" — corrections go through tracking Edit mode instead. */}
                  {item.type === "novel" && (item.progressUnit ?? "chapter") === "chapter" && (
                    <GhostButton
                      label="+1"
                      ariaLabel={`Add one chapter to ${item.title}`}
                      onClick={() => {
                        onUpdateNovelProgress(item, (item.progressValue ?? 0) + 1);
                        setAnnouncement("Chapter progress updated");
                      }}
                    />
                  )}

                  {item.type === "game" && (
                    <>
                      <GhostButton
                        label="+0.5h"
                        ariaLabel={`Add half an hour of playtime to ${item.title}`}
                        onClick={() => {
                          onAdjustPlaytime(item, 0.5);
                          setAnnouncement("Playtime updated");
                        }}
                      />
                      <GhostButton
                        label="+1h"
                        ariaLabel={`Add one hour of playtime to ${item.title}`}
                        onClick={() => {
                          onAdjustPlaytime(item, 1);
                          setAnnouncement("Playtime updated");
                        }}
                      />
                    </>
                  )}
                </div>
              </div>
              {progress?.percent !== undefined && <ProgressBar percent={progress.percent} className="mt-1.5" />}
            </div>
          )}

          <div>
            <dt className="text-xs text-muted-foreground">Your Rating</dt>
            <dd className="text-sm font-medium text-foreground">
              {item.rating !== undefined ? `${item.rating} / 10` : "Unrated"}
            </dd>
          </div>
        </dl>
      )}
    </div>
  );
}

function GhostButton({ label, ariaLabel, onClick }: { label: string; ariaLabel: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      className="rounded px-1.5 py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
    >
      {label}
    </button>
  );
}

function getProgressUnitLabel(item: MediaItem): string {
  switch (item.type) {
    case "anime":
    case "series":
      return "episode";
    case "manga":
      return "chapter";
    case "novel":
      return item.progressUnit === "percent" ? "%" : item.progressUnit === "page" ? "page" : "chapter";
    case "game":
      return "hours";
    case "movie":
      return "";
  }
}

function getCurrentProgressValue(item: MediaItem): number | undefined {
  switch (item.type) {
    case "anime":
    case "series":
      return item.currentEpisode;
    case "manga":
      return item.currentChapter;
    case "novel":
      return item.progressValue;
    case "game":
      return item.playtimeHours;
    case "movie":
      return undefined;
  }
}

interface TrackingEditFormProps {
  item: MediaItem;
  onSave: (patch: TrackingUpdatePatch) => void;
  onCancel: () => void;
}

function TrackingEditForm({ item, onSave, onCancel }: TrackingEditFormProps) {
  const [status, setStatus] = useState<TrackingStatus>(item.status);
  const [ratingValue, setRatingValue] = useState(item.rating !== undefined ? String(item.rating) : "");
  const [progressValue, setProgressValue] = useState(() => {
    const current = getCurrentProgressValue(item);
    return current !== undefined ? String(current) : "";
  });
  const [error, setError] = useState<string | undefined>();

  const unitLabel = getProgressUnitLabel(item);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();

    let rating: number | undefined;
    const trimmedRating = ratingValue.trim();
    if (trimmedRating) {
      const parsed = Number(trimmedRating);
      if (!Number.isFinite(parsed) || parsed < 1 || parsed > 10) {
        setError("Rating must be between 1 and 10.");
        return;
      }
      rating = Math.round(parsed * 2) / 2;
    }

    const patch: TrackingUpdatePatch = { status, rating };
    const trimmedProgress = progressValue.trim();

    if (item.type === "anime" || item.type === "series") {
      if (trimmedProgress) {
        const parsed = Number(trimmedProgress);
        if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
          setError("Episode must be a non-negative whole number.");
          return;
        }
        patch.currentEpisode = item.totalEpisodes !== undefined ? Math.min(parsed, item.totalEpisodes) : parsed;
      }
    } else if (item.type === "manga") {
      if (trimmedProgress) {
        const parsed = Number(trimmedProgress);
        if (!Number.isFinite(parsed) || parsed < 0) {
          setError("Chapter must be a non-negative number.");
          return;
        }
        patch.currentChapter = item.totalChapters !== undefined ? Math.min(parsed, item.totalChapters) : parsed;
      }
    } else if (item.type === "novel") {
      if (trimmedProgress) {
        const parsed = Number(trimmedProgress);
        const unit = item.progressUnit ?? "chapter";
        if (!Number.isFinite(parsed) || parsed < 0 || (unit === "percent" && parsed > 100)) {
          setError(unit === "percent" ? "Percent must be between 0 and 100." : "Progress must be a non-negative number.");
          return;
        }
        patch.progressValue = parsed;
      }
    } else if (item.type === "game") {
      if (trimmedProgress) {
        const parsed = Number(trimmedProgress);
        if (!Number.isFinite(parsed) || parsed < 0) {
          setError("Playtime must be a non-negative number.");
          return;
        }
        patch.playtimeHours = parsed;
      }
    }

    setError(undefined);
    onSave(patch);
  }

  return (
    <form
      onSubmit={handleSubmit}
      onKeyDown={(event) => {
        if (event.key === "Escape") onCancel();
      }}
      className="space-y-3"
    >
      <div>
        <label htmlFor="tracking-status" className="mb-1 block text-xs text-muted-foreground">
          Status
        </label>
        <select
          id="tracking-status"
          value={status}
          onChange={(event) => setStatus(event.target.value as TrackingStatus)}
          className={inputClass(false)}
        >
          {TRACKING_STATUS_OPTIONS[item.type].map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      {item.type !== "movie" && (
        <div>
          <label htmlFor="tracking-progress" className="mb-1 block text-xs text-muted-foreground">
            {item.type === "game" ? "Playtime" : "Progress"}
          </label>
          <div className="flex items-center gap-2">
            <input
              id="tracking-progress"
              type="number"
              inputMode="decimal"
              min={0}
              step={item.type === "anime" || item.type === "series" ? 1 : 0.5}
              value={progressValue}
              onChange={(event) => setProgressValue(event.target.value)}
              className={inputClass(false, "w-24")}
            />
            {unitLabel && <span className="text-xs text-muted-foreground">{unitLabel}</span>}
          </div>
        </div>
      )}

      <div>
        <label htmlFor="tracking-rating" className="mb-1 block text-xs text-muted-foreground">
          Your Rating
        </label>
        <div className="flex items-center gap-2">
          <input
            id="tracking-rating"
            type="number"
            inputMode="decimal"
            min={1}
            max={10}
            step={0.5}
            value={ratingValue}
            onChange={(event) => setRatingValue(event.target.value)}
            placeholder="—"
            aria-invalid={Boolean(error)}
            aria-describedby={error ? "tracking-edit-error" : undefined}
            className={inputClass(Boolean(error), "w-16")}
          />
          <span className="text-xs text-muted-foreground">/ 10</span>
        </div>
      </div>

      {error && (
        <p id="tracking-edit-error" className="text-xs text-red-500">
          {error}
        </p>
      )}

      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          Cancel
        </button>
        <button
          type="submit"
          className="rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background transition-colors hover:bg-foreground/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          Save
        </button>
      </div>
    </form>
  );
}
