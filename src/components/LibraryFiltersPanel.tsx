"use client";

import type { LibraryItemType, TrackingStatus } from "@/types/library-item";
import { ITEM_TYPE_LABELS, SUPPORTED_ITEM_TYPES } from "@/types/library-item";
import type { Collection } from "@/types/collection";
import type { ActivityFilterMode, RatingFilterMode, SmartViewDefinition, TagMatchMode } from "@/types/smart-view";
import type { CategoryOption } from "@/lib/library-items";
import { STATUS_FILTER_LABELS, TRACKING_STATUSES } from "@/lib/tracking";
import { inputClass } from "@/components/FormField";
import { cn, parseCommaList } from "@/lib/utils";
import { ItemTypeIcon } from "@/components/ItemTypeIcon";
import { CheckIcon, PlusIcon } from "@/components/icons";

const ACTIVITY_DAY_PRESETS = [7, 14, 30, 60, 90];

const TILE_CLASS = "flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm transition-colors focus-within:outline-none focus-within:ring-2 focus-within:ring-accent/40 focus-within:ring-offset-1";
// Button-based tiles (an "All"/reset action or a category chip) have no
// sr-only input to anchor :focus-within to, so they use focus-visible on
// the button itself instead — same visual ring, different selector.
const TILE_BUTTON_CLASS = "flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-1";
const TILE_SELECTED = "border-accent bg-accent/5 text-foreground";
const TILE_UNSELECTED = "border-border text-muted-foreground hover:border-foreground/40 hover:text-foreground";

interface LibraryFiltersPanelProps {
  definition: SmartViewDefinition;
  collections: Collection[];
  categories: CategoryOption[];
  activeCategory: string;
  onCategoryChange: (id: string) => void;
  onChange: (definition: SmartViewDefinition) => void;
  onCreateCollection: () => void;
}

/**
 * Ad-hoc advanced filter panel (Stage 31 §2/§37-39) — every control writes
 * directly to the same SmartViewDefinition the engine/Smart Views consume,
 * so this is never a separate filtering implementation. Round 6 replaced
 * the plain checkbox/radio "admin form" look with consumer-facing tiles/
 * chips/a segmented control — same underlying <input type="checkbox"|
 * "radio"> elements throughout (visually composed via a wrapping <label>,
 * the input itself sr-only), so Tab/Space, native ARIA, and multi-select
 * vs. mutually-exclusive semantics are exactly what they were.
 */
export function LibraryFiltersPanel({
  definition,
  collections,
  categories,
  activeCategory,
  onCategoryChange,
  onChange,
  onCreateCollection,
}: LibraryFiltersPanelProps) {
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
      <fieldset className="sm:col-span-2 lg:col-span-3">
        <legend className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">Media Type</legend>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => onChange({ ...definition, mediaTypes: [] })}
            aria-pressed={definition.mediaTypes.length === 0}
            className={cn(TILE_BUTTON_CLASS, definition.mediaTypes.length === 0 ? TILE_SELECTED : TILE_UNSELECTED)}
          >
            All
            {definition.mediaTypes.length === 0 && <CheckIcon width={12} height={12} className="text-accent" aria-hidden="true" />}
          </button>
          {SUPPORTED_ITEM_TYPES.map((type) => {
            const checked = definition.mediaTypes.includes(type);
            return (
              <label key={type} className={cn(TILE_CLASS, checked ? TILE_SELECTED : TILE_UNSELECTED)}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(event) => toggleMediaType(type, event.target.checked)}
                  className="sr-only"
                />
                <ItemTypeIcon type={type} width={15} height={15} className={checked ? "text-accent" : "text-muted-foreground"} aria-hidden="true" />
                {ITEM_TYPE_LABELS[type]}
                {checked && <CheckIcon width={12} height={12} className="text-accent" aria-hidden="true" />}
              </label>
            );
          })}
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">Status</legend>
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => onChange({ ...definition, statuses: [] })}
            aria-pressed={definition.statuses.length === 0}
            className={cn(TILE_BUTTON_CLASS, "py-1", definition.statuses.length === 0 ? TILE_SELECTED : TILE_UNSELECTED)}
          >
            All
            {definition.statuses.length === 0 && <CheckIcon width={11} height={11} className="text-accent" aria-hidden="true" />}
          </button>
          {TRACKING_STATUSES.map((status) => {
            const checked = definition.statuses.includes(status);
            return (
              <label key={status} className={cn(TILE_CLASS, "py-1", checked ? TILE_SELECTED : TILE_UNSELECTED)}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(event) => toggleStatus(status, event.target.checked)}
                  className="sr-only"
                />
                {STATUS_FILTER_LABELS[status]}
                {checked && <CheckIcon width={11} height={11} className="text-accent" aria-hidden="true" />}
              </label>
            );
          })}
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">Favorite</legend>
        <div role="radiogroup" aria-label="Favorite" className="inline-flex rounded-md border border-border p-0.5">
          {([
            { value: null, label: "Any" },
            { value: true, label: "Favorites" },
            { value: false, label: "Not favorite" },
          ] as const).map((option) => {
            const checked = definition.favorite === option.value;
            return (
              <label
                key={String(option.value)}
                className={cn(
                  "cursor-pointer rounded px-2.5 py-1 text-xs font-medium transition-colors focus-within:outline-none focus-within:ring-2 focus-within:ring-accent/40",
                  checked ? "bg-accent/10 text-accent" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <input
                  type="radio"
                  name="smart-view-favorite"
                  checked={checked}
                  onChange={() => onChange({ ...definition, favorite: option.value })}
                  className="sr-only"
                />
                {option.label}
              </label>
            );
          })}
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">Category</legend>
        <div role="group" aria-label="Filter library by category" className="flex flex-wrap gap-1.5">
          {categories.map((option) => {
            const isActive = option.id === activeCategory;
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => onCategoryChange(option.id)}
                aria-pressed={isActive}
                className={cn(TILE_BUTTON_CLASS, "py-1", isActive ? TILE_SELECTED : TILE_UNSELECTED)}
              >
                {option.label}
                <span className={isActive ? "text-accent" : "text-muted-foreground/70"}>{option.count}</span>
              </button>
            );
          })}
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
        <div className="mb-2 flex items-center justify-between gap-2">
          <legend className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">Collection</legend>
          <button
            type="button"
            onClick={onCreateCollection}
            className="flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <PlusIcon width={11} height={11} />
            New
          </button>
        </div>
        {collections.length === 0 ? (
          <p className="text-sm text-muted-foreground">No collections yet.</p>
        ) : (
          <div className="max-h-32 space-y-0.5 overflow-y-auto">
            {collections.map((collection) => {
              const checked = definition.collections.includes(collection.id);
              return (
                <label
                  key={collection.id}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded py-1.5 text-sm text-foreground hover:bg-surface-hover focus-within:outline-none focus-within:ring-2 focus-within:ring-accent/40",
                  )}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(event) => toggleCollection(collection.id, event.target.checked)}
                    className="h-4 w-4 shrink-0 rounded border-border accent-accent"
                  />
                  <span className="truncate">{collection.name}</span>
                </label>
              );
            })}
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
        <div className="mt-1.5 flex items-center gap-3 text-sm text-foreground">
          <label className="flex cursor-pointer items-center gap-1.5">
            <input
              type="radio"
              name="smart-view-tag-match"
              checked={definition.tags.match === "any"}
              onChange={() => onChange({ ...definition, tags: { ...definition.tags, match: "any" as TagMatchMode } })}
              className="h-4 w-4 shrink-0 border-border accent-accent"
            />
            Match any
          </label>
          <label className="flex cursor-pointer items-center gap-1.5">
            <input
              type="radio"
              name="smart-view-tag-match"
              checked={definition.tags.match === "all"}
              onChange={() => onChange({ ...definition, tags: { ...definition.tags, match: "all" as TagMatchMode } })}
              className="h-4 w-4 shrink-0 border-border accent-accent"
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
                  definition.activity.days === days ? "border-accent text-accent" : "border-border text-muted-foreground hover:text-foreground"
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
