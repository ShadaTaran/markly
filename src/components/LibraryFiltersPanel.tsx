"use client";

import type { LibraryItemType, TrackingStatus } from "@/types/library-item";
import { ITEM_TYPE_LABELS, SUPPORTED_ITEM_TYPES } from "@/types/library-item";
import type { Collection } from "@/types/collection";
import type { ActivityFilterMode, RatingFilterMode, SmartViewDefinition, TagMatchMode } from "@/types/smart-view";
import { STATUS_FILTER_LABELS, TRACKING_STATUSES } from "@/lib/tracking";
import { inputClass } from "@/components/FormField";
import { parseCommaList } from "@/lib/utils";

const ACTIVITY_DAY_PRESETS = [7, 14, 30, 60, 90];

interface LibraryFiltersPanelProps {
  definition: SmartViewDefinition;
  collections: Collection[];
  onChange: (definition: SmartViewDefinition) => void;
}

/**
 * Ad-hoc advanced filter panel (Stage 31 §2/§37-39) — every control writes
 * directly to the same SmartViewDefinition the engine/Smart Views consume,
 * so this is never a separate filtering implementation. Stacked, compact
 * sections rather than a giant always-visible form (§89) — the parent only
 * renders this while the user has it open.
 */
export function LibraryFiltersPanel({ definition, collections, onChange }: LibraryFiltersPanelProps) {
  function toggleMediaType(type: LibraryItemType, checked: boolean) {
    onChange({ ...definition, mediaTypes: checked ? [...definition.mediaTypes, type] : definition.mediaTypes.filter((t) => t !== type) });
  }

  function toggleStatus(status: TrackingStatus, checked: boolean) {
    onChange({ ...definition, statuses: checked ? [...definition.statuses, status] : definition.statuses.filter((s) => s !== status) });
  }

  function toggleCollection(id: string, checked: boolean) {
    onChange({ ...definition, collections: checked ? [...definition.collections, id] : definition.collections.filter((c) => c !== id) });
  }

  return (
    <div className="grid gap-5 rounded-md border border-border bg-surface p-4 sm:grid-cols-2 lg:grid-cols-3">
      <fieldset>
        <legend className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">Media Type</legend>
        <div className="space-y-1.5">
          {SUPPORTED_ITEM_TYPES.map((type) => (
            <label key={type} className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={definition.mediaTypes.includes(type)}
                onChange={(event) => toggleMediaType(type, event.target.checked)}
                className="h-4 w-4 shrink-0 rounded border-border accent-foreground"
              />
              {ITEM_TYPE_LABELS[type]}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">Status</legend>
        <div className="space-y-1.5">
          {TRACKING_STATUSES.map((status) => (
            <label key={status} className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={definition.statuses.includes(status)}
                onChange={(event) => toggleStatus(status, event.target.checked)}
                className="h-4 w-4 shrink-0 rounded border-border accent-foreground"
              />
              {STATUS_FILTER_LABELS[status]}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">Favorite</legend>
        <div className="space-y-1.5">
          {([
            { value: null, label: "Any" },
            { value: true, label: "Favorites only" },
            { value: false, label: "Not favorite" },
          ] as const).map((option) => (
            <label key={String(option.value)} className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
              <input
                type="radio"
                name="smart-view-favorite"
                checked={definition.favorite === option.value}
                onChange={() => onChange({ ...definition, favorite: option.value })}
                className="h-4 w-4 shrink-0 border-border accent-foreground"
              />
              {option.label}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">Rating</legend>
        <select
          value={definition.rating.mode}
          onChange={(event) => {
            const mode = event.target.value as RatingFilterMode;
            onChange({ ...definition, rating: { mode, min: mode === "any" || mode === "rated" || mode === "unrated" ? null : (definition.rating.min ?? 1), max: mode === "range" ? (definition.rating.max ?? 10) : null } });
          }}
          className={inputClass(false)}
          aria-label="Rating filter mode"
        >
          <option value="any">Any rating</option>
          <option value="rated">Rated</option>
          <option value="unrated">Unrated</option>
          <option value="min">Minimum rating</option>
          <option value="range">Rating range</option>
        </select>
        {(definition.rating.mode === "min" || definition.rating.mode === "range") && (
          <div className="mt-2 flex items-center gap-2">
            <input
              type="number"
              min={1}
              max={10}
              step={0.5}
              value={definition.rating.min ?? ""}
              onChange={(event) => onChange({ ...definition, rating: { ...definition.rating, min: event.target.value === "" ? null : Number(event.target.value) } })}
              aria-label="Minimum rating"
              className={inputClass(false, "w-20")}
            />
            {definition.rating.mode === "range" && (
              <>
                <span className="text-sm text-muted-foreground">to</span>
                <input
                  type="number"
                  min={1}
                  max={10}
                  step={0.5}
                  value={definition.rating.max ?? ""}
                  onChange={(event) => onChange({ ...definition, rating: { ...definition.rating, max: event.target.value === "" ? null : Number(event.target.value) } })}
                  aria-label="Maximum rating"
                  className={inputClass(false, "w-20")}
                />
              </>
            )}
          </div>
        )}
      </fieldset>

      <fieldset>
        <legend className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">Collection (any selected)</legend>
        {collections.length === 0 ? (
          <p className="text-sm text-muted-foreground">No collections yet.</p>
        ) : (
          <div className="max-h-32 space-y-1.5 overflow-y-auto">
            {collections.map((collection) => (
              <label key={collection.id} className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={definition.collections.includes(collection.id)}
                  onChange={(event) => toggleCollection(collection.id, event.target.checked)}
                  className="h-4 w-4 shrink-0 rounded border-border accent-foreground"
                />
                <span className="truncate">{collection.name}</span>
              </label>
            ))}
          </div>
        )}
      </fieldset>

      <fieldset>
        <legend className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">Tags</legend>
        <input
          type="text"
          value={definition.tags.values.join(", ")}
          onChange={(event) => onChange({ ...definition, tags: { ...definition.tags, values: parseCommaList(event.target.value).map((t) => t.toLowerCase()) } })}
          placeholder="comma, separated, tags"
          className={inputClass(false)}
          aria-label="Tags"
        />
        <div className="mt-2 flex items-center gap-3 text-sm text-foreground">
          <label className="flex cursor-pointer items-center gap-1.5">
            <input
              type="radio"
              name="smart-view-tag-match"
              checked={definition.tags.match === "any"}
              onChange={() => onChange({ ...definition, tags: { ...definition.tags, match: "any" as TagMatchMode } })}
              className="h-4 w-4 shrink-0 border-border accent-foreground"
            />
            Match any
          </label>
          <label className="flex cursor-pointer items-center gap-1.5">
            <input
              type="radio"
              name="smart-view-tag-match"
              checked={definition.tags.match === "all"}
              onChange={() => onChange({ ...definition, tags: { ...definition.tags, match: "all" as TagMatchMode } })}
              className="h-4 w-4 shrink-0 border-border accent-foreground"
            />
            Match all
          </label>
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">Activity</legend>
        <select
          value={definition.activity.mode}
          onChange={(event) => {
            const mode = event.target.value as ActivityFilterMode;
            onChange({ ...definition, activity: { mode, days: mode === "active_within" || mode === "inactive_for" ? (definition.activity.days ?? 14) : null } });
          }}
          className={inputClass(false)}
          aria-label="Activity filter mode"
        >
          <option value="any">Any</option>
          <option value="active_within">Active within…</option>
          <option value="inactive_for">Inactive for at least…</option>
          <option value="never">Never active</option>
        </select>
        {(definition.activity.mode === "active_within" || definition.activity.mode === "inactive_for") && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {ACTIVITY_DAY_PRESETS.map((days) => (
              <button
                key={days}
                type="button"
                onClick={() => onChange({ ...definition, activity: { ...definition.activity, days } })}
                className={`rounded-md border px-2 py-1 text-xs font-medium transition-colors ${
                  definition.activity.days === days ? "border-foreground text-foreground" : "border-border text-muted-foreground hover:text-foreground"
                }`}
              >
                {days}d
              </button>
            ))}
            <input
              type="number"
              min={1}
              value={definition.activity.days ?? ""}
              onChange={(event) => onChange({ ...definition, activity: { ...definition.activity, days: event.target.value === "" ? null : Number(event.target.value) } })}
              aria-label="Custom number of days"
              className={inputClass(false, "w-16")}
            />
          </div>
        )}
      </fieldset>
    </div>
  );
}
