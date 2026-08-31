"use client";

import { useState, type FormEvent } from "react";
import type { MediaItem, NovelProgressUnit, TrackingStatus } from "@/types/library-item";
import { TRACKING_STATUS_OPTIONS } from "@/lib/tracking";
import { parseCount, parseDecimal, parsePercent, parseRating } from "@/lib/form-number-parsing";
import type { CatalogDisplay } from "@/lib/metadata/display";
import { Field, inputClass } from "@/components/FormField";
import { ItemTypeIcon } from "@/components/ItemTypeIcon";

export interface PersonalTrackingValues {
  status: TrackingStatus;
  rating?: number;
  currentEpisode?: number;
  currentChapter?: number;
  progressValue?: number;
  progressUnit?: NovelProgressUnit;
  playtimeHours?: number;
}

interface CatalogTrackingFormProps {
  type: MediaItem["type"];
  display: CatalogDisplay;
  /** Known catalog totals, used only to validate progress doesn't exceed them. */
  totalEpisodes?: number;
  totalChapters?: number;
  mode: "add" | "edit";
  initial: PersonalTrackingValues;
  onSubmit: (values: PersonalTrackingValues) => void;
  /** Add mode only — returns to search results. */
  onChangeSelection?: () => void;
  onEditFullDetails: () => void;
  onCancel: () => void;
}

interface FormState {
  currentEpisode: string;
  currentChapter: string;
  progressValue: string;
  progressUnit: string;
  playtimeHours: string;
  rating: string;
  status: string;
}

type FormErrors = Partial<
  Record<"rating" | "currentEpisode" | "currentChapter" | "progressValue" | "playtimeHours", string>
>;

function toFormState(initial: PersonalTrackingValues): FormState {
  return {
    currentEpisode: initial.currentEpisode !== undefined ? String(initial.currentEpisode) : "",
    currentChapter: initial.currentChapter !== undefined ? String(initial.currentChapter) : "",
    progressValue: initial.progressValue !== undefined ? String(initial.progressValue) : "",
    progressUnit: initial.progressUnit ?? "chapter",
    playtimeHours: initial.playtimeHours !== undefined ? String(initial.playtimeHours) : "",
    rating: initial.rating !== undefined ? String(initial.rating) : "",
    status: initial.status,
  };
}

export function CatalogTrackingForm({
  type,
  display,
  totalEpisodes,
  totalChapters,
  mode,
  initial,
  onSubmit,
  onChangeSelection,
  onEditFullDetails,
  onCancel,
}: CatalogTrackingFormProps) {
  const [values, setValues] = useState<FormState>(() => toFormState(initial));
  const [errors, setErrors] = useState<FormErrors>({});
  const [imageFailed, setImageFailed] = useState(false);
  const showImage = Boolean(display.imageUrl) && !imageFailed;

  function updateField<K extends keyof FormState>(field: K, value: string) {
    setValues((prev) => ({ ...prev, [field]: value }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();

    const nextErrors: FormErrors = {};
    const rating = parseRating(values.rating);
    if (rating.error) nextErrors.rating = rating.error;

    let progress: Partial<PersonalTrackingValues> = {};
    let hasProgress = false;

    if (type === "anime" || type === "series") {
      const current = parseCount(values.currentEpisode, "Current episode");
      if (current.error) nextErrors.currentEpisode = current.error;
      if (!current.error && current.value !== undefined && totalEpisodes !== undefined && current.value > totalEpisodes) {
        nextErrors.currentEpisode = "Current episode can't exceed total episodes.";
      }
      progress = { currentEpisode: current.value };
      hasProgress = (current.value ?? 0) > 0;
    } else if (type === "manga") {
      const current = parseDecimal(values.currentChapter, "Current chapter");
      if (current.error) nextErrors.currentChapter = current.error;
      if (!current.error && current.value !== undefined && totalChapters !== undefined && current.value > totalChapters) {
        nextErrors.currentChapter = "Current chapter can't exceed total chapters.";
      }
      progress = { currentChapter: current.value };
      hasProgress = (current.value ?? 0) > 0;
    } else if (type === "novel") {
      const unit = values.progressUnit as NovelProgressUnit;
      const parsed =
        unit === "percent"
          ? parsePercent(values.progressValue)
          : parseDecimal(values.progressValue, unit === "page" ? "Page" : "Chapter");
      if (parsed.error) nextErrors.progressValue = parsed.error;
      progress = { progressValue: parsed.value, progressUnit: parsed.value !== undefined ? unit : undefined };
      hasProgress = (parsed.value ?? 0) > 0;
    } else if (type === "game") {
      const playtime = parseDecimal(values.playtimeHours, "Playtime");
      if (playtime.error) nextErrors.playtimeHours = playtime.error;
      progress = { playtimeHours: playtime.value };
      hasProgress = (playtime.value ?? 0) > 0;
    }

    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }

    // Add: status is inferred rather than asked for — planned by default,
    // in_progress once real progress is entered (only for types that
    // actually support that status). Edit: the user controls it directly,
    // including special statuses like on hold/dropped.
    const status: TrackingStatus =
      mode === "add"
        ? hasProgress && TRACKING_STATUS_OPTIONS[type].some((option) => option.value === "in_progress")
          ? "in_progress"
          : "planned"
        : (values.status as TrackingStatus);

    onSubmit({ status, rating: rating.value, ...progress });
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-4">
      <div className="flex items-start gap-3 rounded-md border border-border bg-background p-3">
        <span className="flex h-16 w-12 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-surface">
          {showImage ? (
            // eslint-disable-next-line @next/next/no-img-element -- catalog cover art from arbitrary hosts; next/image's optimizer isn't a good fit here.
            <img
              src={display.imageUrl}
              alt={`${display.title} cover`}
              className="h-full w-full object-cover"
              onError={() => setImageFailed(true)}
            />
          ) : (
            <ItemTypeIcon type={type} width={18} height={18} className="text-muted-foreground" aria-hidden="true" />
          )}
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">{display.title}</p>
          {display.genresLine && (
            <p className="truncate text-xs text-muted-foreground">{display.genresLine}</p>
          )}
          {display.metaLine && <p className="truncate text-xs text-muted-foreground">{display.metaLine}</p>}
        </div>
      </div>

      {mode === "edit" && (
        <Field label="Status" htmlFor="catalog-status">
          <select
            id="catalog-status"
            value={values.status}
            onChange={(event) => updateField("status", event.target.value)}
            className={inputClass(false)}
          >
            {TRACKING_STATUS_OPTIONS[type].map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
      )}

      {(type === "anime" || type === "series") && (
        <Field
          label="Progress"
          htmlFor="catalog-current-episode"
          error={errors.currentEpisode}
          hint={totalEpisodes !== undefined ? `Episode, out of ${totalEpisodes}.` : "Current episode."}
        >
          <input
            id="catalog-current-episode"
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            value={values.currentEpisode}
            onChange={(event) => updateField("currentEpisode", event.target.value)}
            aria-invalid={Boolean(errors.currentEpisode)}
            aria-describedby={errors.currentEpisode ? "catalog-current-episode-error" : undefined}
            className={inputClass(Boolean(errors.currentEpisode))}
            placeholder="0"
          />
        </Field>
      )}

      {type === "manga" && (
        <Field
          label="Progress"
          htmlFor="catalog-current-chapter"
          error={errors.currentChapter}
          hint={totalChapters !== undefined ? `Chapter, out of ${totalChapters}.` : "Current chapter."}
        >
          <input
            id="catalog-current-chapter"
            type="number"
            inputMode="decimal"
            min={0}
            step={0.5}
            value={values.currentChapter}
            onChange={(event) => updateField("currentChapter", event.target.value)}
            aria-invalid={Boolean(errors.currentChapter)}
            aria-describedby={errors.currentChapter ? "catalog-current-chapter-error" : undefined}
            className={inputClass(Boolean(errors.currentChapter))}
            placeholder="0"
          />
        </Field>
      )}

      {type === "novel" && (
        <div className="grid grid-cols-[1fr_auto] gap-3">
          <Field label="Progress" htmlFor="catalog-progress-value" error={errors.progressValue}>
            <input
              id="catalog-progress-value"
              type="number"
              inputMode="decimal"
              min={0}
              max={values.progressUnit === "percent" ? 100 : undefined}
              step={values.progressUnit === "percent" ? 1 : 0.5}
              value={values.progressValue}
              onChange={(event) => updateField("progressValue", event.target.value)}
              aria-invalid={Boolean(errors.progressValue)}
              aria-describedby={errors.progressValue ? "catalog-progress-value-error" : undefined}
              className={inputClass(Boolean(errors.progressValue))}
              placeholder="e.g. 42"
            />
          </Field>
          <Field label="Unit" htmlFor="catalog-progress-unit">
            <select
              id="catalog-progress-unit"
              value={values.progressUnit}
              onChange={(event) => updateField("progressUnit", event.target.value)}
              className={inputClass(false)}
            >
              <option value="chapter">Chapter</option>
              <option value="page">Page</option>
              <option value="percent">Percent</option>
            </select>
          </Field>
        </div>
      )}

      {type === "game" && (
        <Field
          label="Playtime (hours)"
          htmlFor="catalog-playtime"
          error={errors.playtimeHours}
          hint="Optional. Total hours played so far."
        >
          <input
            id="catalog-playtime"
            type="number"
            inputMode="decimal"
            min={0}
            step={0.5}
            value={values.playtimeHours}
            onChange={(event) => updateField("playtimeHours", event.target.value)}
            aria-invalid={Boolean(errors.playtimeHours)}
            aria-describedby={errors.playtimeHours ? "catalog-playtime-error" : undefined}
            className={inputClass(Boolean(errors.playtimeHours))}
            placeholder="e.g. 37.5"
          />
        </Field>
      )}

      <Field label="Rating" htmlFor="catalog-rating" error={errors.rating} hint="Optional. 1–10, halves allowed.">
        <div className="flex items-center gap-2">
          <input
            id="catalog-rating"
            type="number"
            inputMode="decimal"
            min={1}
            max={10}
            step={0.5}
            value={values.rating}
            onChange={(event) => updateField("rating", event.target.value)}
            aria-invalid={Boolean(errors.rating)}
            aria-describedby={errors.rating ? "catalog-rating-error" : undefined}
            className={inputClass(Boolean(errors.rating), "w-24")}
            placeholder="8.5"
          />
          <span className="text-sm text-muted-foreground">/ 10</span>
        </div>
      </Field>

      <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {onChangeSelection && (
            <button
              type="button"
              onClick={onChangeSelection}
              className="text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              Change selection
            </button>
          )}
          <button
            type="button"
            onClick={onEditFullDetails}
            className="text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            Edit full details
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-border px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="rounded-md bg-foreground px-3.5 py-2 text-sm font-medium text-background transition-colors hover:bg-foreground/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            {mode === "edit" ? "Save Changes" : "Add to Library"}
          </button>
        </div>
      </div>
    </form>
  );
}
