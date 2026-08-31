"use client";

import { useId, useState, type FormEvent } from "react";
import type { MediaItem, MediaItemInput, NovelProgressUnit, TrackingStatus } from "@/types/library-item";
import { ITEM_TYPE_LABELS } from "@/types/library-item";
import { cn, parseCommaList, parseTags } from "@/lib/utils";
import { isValidUrl, normalizeUrl } from "@/lib/website";
import { TRACKING_STATUS_OPTIONS } from "@/lib/tracking";
import type { MetadataDetails } from "@/lib/metadata/types";
import { parseCount, parseDecimal, parsePercent, parseRating } from "@/lib/form-number-parsing";
import { Field, inputClass } from "@/components/FormField";

interface MediaItemFormProps {
  type: MediaItem["type"];
  initialValues?: MediaItem;
  /** Autofill data from a metadata search selection — add mode only, never used when editing. */
  prefill?: MetadataDetails;
  existingCategories: string[];
  onSubmit: (values: MediaItemInput) => void;
  onCancel: () => void;
}

interface FormState {
  title: string;
  description: string;
  imageUrl: string;
  sourceUrl: string;
  category: string;
  tags: string;
  platform: string;
  status: string;
  currentEpisode: string;
  totalEpisodes: string;
  currentChapter: string;
  totalChapters: string;
  progressValue: string;
  progressUnit: string;
  rating: string;
  playtimeHours: string;
  authors: string;
  studio: string;
  pageCount: string;
}

type FormErrors = Partial<
  Record<
    | "title"
    | "category"
    | "imageUrl"
    | "sourceUrl"
    | "rating"
    | "currentEpisode"
    | "totalEpisodes"
    | "currentChapter"
    | "totalChapters"
    | "progressValue"
    | "playtimeHours"
    | "pageCount",
    string
  >
>;

function toFormState(type: MediaItem["type"], item?: MediaItem, prefill?: MetadataDetails): FormState {
  return {
    title: item?.title ?? prefill?.title ?? "",
    description: item?.description ?? prefill?.description ?? "",
    imageUrl: item?.imageUrl ?? prefill?.imageUrl ?? "",
    sourceUrl: item?.sourceUrl ?? "",
    category: item?.category ?? "",
    tags: item?.tags.join(", ") ?? "",
    platform: item && item.type === "game" ? (item.platform ?? "") : "",
    status: item?.status ?? "planned",
    currentEpisode:
      item && (item.type === "anime" || item.type === "series") && item.currentEpisode !== undefined
        ? String(item.currentEpisode)
        : "",
    totalEpisodes:
      item && (item.type === "anime" || item.type === "series") && item.totalEpisodes !== undefined
        ? String(item.totalEpisodes)
        : !item && (type === "anime" || type === "series") && prefill?.totalEpisodes !== undefined
          ? String(prefill.totalEpisodes)
          : "",
    currentChapter:
      item && item.type === "manga" && item.currentChapter !== undefined ? String(item.currentChapter) : "",
    totalChapters:
      item && item.type === "manga" && item.totalChapters !== undefined
        ? String(item.totalChapters)
        : !item && type === "manga" && prefill?.totalChapters !== undefined
          ? String(prefill.totalChapters)
          : "",
    progressValue:
      item && item.type === "novel" && item.progressValue !== undefined ? String(item.progressValue) : "",
    progressUnit: item && item.type === "novel" ? item.progressUnit ?? "chapter" : "chapter",
    rating: item?.rating !== undefined ? String(item.rating) : "",
    playtimeHours:
      item && item.type === "game" && item.playtimeHours !== undefined ? String(item.playtimeHours) : "",
    authors:
      item && (item.type === "novel" || item.type === "manga") && item.authors
        ? item.authors.join(", ")
        : !item && (type === "novel" || type === "manga") && prefill?.authors
          ? prefill.authors.join(", ")
          : "",
    studio:
      item && item.type === "anime"
        ? item.studio ?? ""
        : !item && type === "anime"
          ? prefill?.studio ?? ""
          : "",
    pageCount:
      item && item.type === "novel" && item.pageCount !== undefined
        ? String(item.pageCount)
        : !item && type === "novel" && prefill?.pageCount !== undefined
          ? String(prefill.pageCount)
          : "",
  };
}

function emptyToUndefined(value: string): string | undefined {
  return value.trim() ? value.trim() : undefined;
}

/** Validates an optional URL field: empty is fine, otherwise must be safe http/https. */
function validateOptionalUrl(raw: string): { value: string; error?: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { value: "" };

  const normalized = normalizeUrl(trimmed);
  if (!isValidUrl(normalized)) {
    return { value: normalized, error: "Enter a valid URL, e.g. example.com" };
  }
  return { value: normalized };
}

export function MediaItemForm({
  type,
  initialValues,
  prefill,
  existingCategories,
  onSubmit,
  onCancel,
}: MediaItemFormProps) {
  const [values, setValues] = useState<FormState>(() => toFormState(type, initialValues, prefill));
  const [errors, setErrors] = useState<FormErrors>({});
  // Catalog fields the form doesn't expose as inputs (genres, release year,
  // developer/publisher, catalog platforms, provenance) are carried through
  // untouched from the search selection — captured once here so editing an
  // existing item (prefill is never passed then) can't clobber them.
  const [catalogData] = useState<MetadataDetails | undefined>(() => (initialValues ? undefined : prefill));
  const datalistId = useId();

  function updateField<K extends keyof FormState>(field: K, value: string) {
    setValues((prev) => ({ ...prev, [field]: value }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();

    const nextErrors: FormErrors = {};

    if (!values.title.trim()) nextErrors.title = "Title is required.";
    if (!values.category.trim()) nextErrors.category = "Category is required.";

    const image = validateOptionalUrl(values.imageUrl);
    if (image.error) nextErrors.imageUrl = image.error;

    const source = validateOptionalUrl(values.sourceUrl);
    if (source.error) nextErrors.sourceUrl = source.error;

    const rating = parseRating(values.rating);
    if (rating.error) nextErrors.rating = rating.error;

    const common = {
      title: values.title.trim(),
      description: values.description.trim(),
      category: values.category.trim(),
      tags: parseTags(values.tags),
      imageUrl: emptyToUndefined(image.value),
      sourceUrl: emptyToUndefined(source.value),
      status: values.status as TrackingStatus,
      rating: rating.value,
      releaseYear: catalogData?.year,
      catalogSource: catalogData ? { provider: catalogData.provider, externalId: catalogData.externalId } : undefined,
    };

    if (type === "anime" || type === "series") {
      const current = parseCount(values.currentEpisode, "Current episode");
      const total = parseCount(values.totalEpisodes, "Total episodes", { positive: true });
      if (current.error) nextErrors.currentEpisode = current.error;
      if (total.error) nextErrors.totalEpisodes = total.error;
      if (
        !current.error &&
        !total.error &&
        current.value !== undefined &&
        total.value !== undefined &&
        current.value > total.value
      ) {
        nextErrors.currentEpisode = "Current episode can't exceed total episodes.";
      }

      if (Object.keys(nextErrors).length > 0) {
        setErrors(nextErrors);
        return;
      }

      if (type === "anime") {
        onSubmit({
          ...common,
          currentEpisode: current.value,
          totalEpisodes: total.value,
          genres: catalogData?.genres,
          studio: emptyToUndefined(values.studio),
        });
      } else {
        onSubmit({
          ...common,
          currentEpisode: current.value,
          totalEpisodes: total.value,
          genres: catalogData?.genres,
        });
      }
      return;
    }

    if (type === "manga") {
      const current = parseDecimal(values.currentChapter, "Current chapter");
      const total = parseCount(values.totalChapters, "Total chapters", { positive: true });
      if (current.error) nextErrors.currentChapter = current.error;
      if (total.error) nextErrors.totalChapters = total.error;
      if (
        !current.error &&
        !total.error &&
        current.value !== undefined &&
        total.value !== undefined &&
        current.value > total.value
      ) {
        nextErrors.currentChapter = "Current chapter can't exceed total chapters.";
      }

      if (Object.keys(nextErrors).length > 0) {
        setErrors(nextErrors);
        return;
      }
      const mangaAuthors = parseCommaList(values.authors);
      onSubmit({
        ...common,
        currentChapter: current.value,
        totalChapters: total.value,
        genres: catalogData?.genres,
        authors: mangaAuthors.length > 0 ? mangaAuthors : undefined,
      });
      return;
    }

    if (type === "novel") {
      const unit = values.progressUnit as NovelProgressUnit;
      const progress =
        unit === "percent"
          ? parsePercent(values.progressValue)
          : parseDecimal(values.progressValue, unit === "page" ? "Page" : "Chapter");
      if (progress.error) nextErrors.progressValue = progress.error;

      const pageCount = parseCount(values.pageCount, "Page count", { positive: true });
      if (pageCount.error) nextErrors.pageCount = pageCount.error;

      if (Object.keys(nextErrors).length > 0) {
        setErrors(nextErrors);
        return;
      }
      const authors = parseCommaList(values.authors);
      onSubmit({
        ...common,
        progressValue: progress.value,
        progressUnit: progress.value !== undefined ? unit : undefined,
        authors: authors.length > 0 ? authors : undefined,
        pageCount: pageCount.value,
      });
      return;
    }

    if (type === "game") {
      const playtime = parseDecimal(values.playtimeHours, "Playtime");
      if (playtime.error) nextErrors.playtimeHours = playtime.error;

      if (Object.keys(nextErrors).length > 0) {
        setErrors(nextErrors);
        return;
      }
      onSubmit({
        ...common,
        platform: emptyToUndefined(values.platform),
        playtimeHours: playtime.value,
        developer: catalogData?.developer,
        publisher: catalogData?.publisher,
        catalogPlatforms: catalogData?.catalogPlatforms,
      });
      return;
    }

    // movie: status + rating only, no progress fields
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }
    onSubmit({ ...common, genres: catalogData?.genres });
  }

  const label = ITEM_TYPE_LABELS[type];
  const statusOptions = TRACKING_STATUS_OPTIONS[type];

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-4">
      <Field label="Title" htmlFor="media-title" error={errors.title} required>
        <input
          id="media-title"
          type="text"
          value={values.title}
          onChange={(event) => updateField("title", event.target.value)}
          aria-invalid={Boolean(errors.title)}
          aria-describedby={errors.title ? "media-title-error" : undefined}
          className={inputClass(Boolean(errors.title))}
          placeholder={`e.g. ${label === "Novel / Book" ? "The Hobbit" : label + " title"}`}
        />
      </Field>

      <Field label="Description" htmlFor="media-description">
        <textarea
          id="media-description"
          value={values.description}
          onChange={(event) => updateField("description", event.target.value)}
          rows={3}
          className={cn(inputClass(false), "resize-none")}
          placeholder="A short synopsis or note"
        />
      </Field>

      <Field
        label="Cover image URL"
        htmlFor="media-image-url"
        error={errors.imageUrl}
        hint="Optional. Link to a poster or cover image."
      >
        <input
          id="media-image-url"
          type="text"
          value={values.imageUrl}
          onChange={(event) => updateField("imageUrl", event.target.value)}
          aria-invalid={Boolean(errors.imageUrl)}
          aria-describedby={errors.imageUrl ? "media-image-url-error" : undefined}
          className={inputClass(Boolean(errors.imageUrl))}
          placeholder="e.g. example.com/cover.jpg"
        />
      </Field>

      <Field
        label="Source / reference URL"
        htmlFor="media-source-url"
        error={errors.sourceUrl}
        hint="Optional. Where you found or track this."
      >
        <input
          id="media-source-url"
          type="text"
          value={values.sourceUrl}
          onChange={(event) => updateField("sourceUrl", event.target.value)}
          aria-invalid={Boolean(errors.sourceUrl)}
          aria-describedby={errors.sourceUrl ? "media-source-url-error" : undefined}
          className={inputClass(Boolean(errors.sourceUrl))}
          placeholder="e.g. myanimelist.net/anime/..."
        />
      </Field>

      {type === "game" && (
        <Field label="Platform" htmlFor="media-platform" hint="Optional. e.g. PC, PS5, Switch.">
          <input
            id="media-platform"
            type="text"
            value={values.platform}
            onChange={(event) => updateField("platform", event.target.value)}
            className={inputClass(false)}
            placeholder="e.g. PC"
          />
        </Field>
      )}

      {(type === "novel" || type === "manga") && (
        <Field
          label="Author(s)"
          htmlFor="media-authors"
          hint="Optional. Separate multiple authors with commas."
        >
          <input
            id="media-authors"
            type="text"
            value={values.authors}
            onChange={(event) => updateField("authors", event.target.value)}
            className={inputClass(false)}
            placeholder={type === "novel" ? "e.g. Frank Herbert" : "e.g. Kentaro Miura"}
          />
        </Field>
      )}

      {type === "novel" && (
        <Field
          label="Page count"
          htmlFor="media-page-count"
          error={errors.pageCount}
          hint="Optional."
        >
          <input
            id="media-page-count"
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            value={values.pageCount}
            onChange={(event) => updateField("pageCount", event.target.value)}
            aria-invalid={Boolean(errors.pageCount)}
            aria-describedby={errors.pageCount ? "media-page-count-error" : undefined}
            className={inputClass(Boolean(errors.pageCount))}
            placeholder="e.g. 412"
          />
        </Field>
      )}

      {type === "anime" && (
        <Field label="Studio" htmlFor="media-studio" hint="Optional.">
          <input
            id="media-studio"
            type="text"
            value={values.studio}
            onChange={(event) => updateField("studio", event.target.value)}
            className={inputClass(false)}
            placeholder="e.g. Madhouse"
          />
        </Field>
      )}

      <Field
        label="Category"
        htmlFor="media-category"
        error={errors.category}
        hint="Choose an existing category or type a new one."
        required
      >
        <input
          id="media-category"
          type="text"
          list={datalistId}
          value={values.category}
          onChange={(event) => updateField("category", event.target.value)}
          aria-invalid={Boolean(errors.category)}
          aria-describedby={errors.category ? "media-category-error" : undefined}
          className={inputClass(Boolean(errors.category))}
          placeholder="e.g. Fantasy"
        />
        <datalist id={datalistId}>
          {existingCategories.map((category) => (
            <option key={category} value={category} />
          ))}
        </datalist>
      </Field>

      <Field label="Tags" htmlFor="media-tags" hint="Separate tags with commas.">
        <input
          id="media-tags"
          type="text"
          value={values.tags}
          onChange={(event) => updateField("tags", event.target.value)}
          className={inputClass(false)}
          placeholder="e.g. adventure, fantasy"
        />
      </Field>

      <div className="space-y-4 border-t border-border pt-4">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
          Tracking
        </p>

        <Field label="Status" htmlFor="media-status">
          <select
            id="media-status"
            value={values.status}
            onChange={(event) => updateField("status", event.target.value)}
            className={inputClass(false)}
          >
            {statusOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>

        {(type === "anime" || type === "series") && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Current Episode" htmlFor="media-current-episode" error={errors.currentEpisode}>
              <input
                id="media-current-episode"
                type="number"
                inputMode="numeric"
                min={0}
                step={1}
                value={values.currentEpisode}
                onChange={(event) => updateField("currentEpisode", event.target.value)}
                aria-invalid={Boolean(errors.currentEpisode)}
                aria-describedby={errors.currentEpisode ? "media-current-episode-error" : undefined}
                className={inputClass(Boolean(errors.currentEpisode))}
                placeholder="0"
              />
            </Field>
            <Field
              label="Total Episodes"
              htmlFor="media-total-episodes"
              error={errors.totalEpisodes}
              hint="Optional"
            >
              <input
                id="media-total-episodes"
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                value={values.totalEpisodes}
                onChange={(event) => updateField("totalEpisodes", event.target.value)}
                aria-invalid={Boolean(errors.totalEpisodes)}
                aria-describedby={errors.totalEpisodes ? "media-total-episodes-error" : undefined}
                className={inputClass(Boolean(errors.totalEpisodes))}
                placeholder="e.g. 24"
              />
            </Field>
          </div>
        )}

        {type === "manga" && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Current Chapter" htmlFor="media-current-chapter" error={errors.currentChapter}>
              <input
                id="media-current-chapter"
                type="number"
                inputMode="decimal"
                min={0}
                step={0.5}
                value={values.currentChapter}
                onChange={(event) => updateField("currentChapter", event.target.value)}
                aria-invalid={Boolean(errors.currentChapter)}
                aria-describedby={errors.currentChapter ? "media-current-chapter-error" : undefined}
                className={inputClass(Boolean(errors.currentChapter))}
                placeholder="0"
              />
            </Field>
            <Field
              label="Total Chapters"
              htmlFor="media-total-chapters"
              error={errors.totalChapters}
              hint="Optional"
            >
              <input
                id="media-total-chapters"
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                value={values.totalChapters}
                onChange={(event) => updateField("totalChapters", event.target.value)}
                aria-invalid={Boolean(errors.totalChapters)}
                aria-describedby={errors.totalChapters ? "media-total-chapters-error" : undefined}
                className={inputClass(Boolean(errors.totalChapters))}
                placeholder="e.g. 120"
              />
            </Field>
          </div>
        )}

        {type === "novel" && (
          <div className="grid grid-cols-[1fr_auto] gap-3">
            <Field label="Progress" htmlFor="media-progress-value" error={errors.progressValue}>
              <input
                id="media-progress-value"
                type="number"
                inputMode="decimal"
                min={0}
                max={values.progressUnit === "percent" ? 100 : undefined}
                step={values.progressUnit === "percent" ? 1 : 0.5}
                value={values.progressValue}
                onChange={(event) => updateField("progressValue", event.target.value)}
                aria-invalid={Boolean(errors.progressValue)}
                aria-describedby={errors.progressValue ? "media-progress-value-error" : undefined}
                className={inputClass(Boolean(errors.progressValue))}
                placeholder="e.g. 42"
              />
            </Field>
            <Field label="Unit" htmlFor="media-progress-unit">
              <select
                id="media-progress-unit"
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
            htmlFor="media-playtime"
            error={errors.playtimeHours}
            hint="Optional. Total hours played so far."
          >
            <input
              id="media-playtime"
              type="number"
              inputMode="decimal"
              min={0}
              step={0.5}
              value={values.playtimeHours}
              onChange={(event) => updateField("playtimeHours", event.target.value)}
              aria-invalid={Boolean(errors.playtimeHours)}
              aria-describedby={errors.playtimeHours ? "media-playtime-error" : undefined}
              className={inputClass(Boolean(errors.playtimeHours))}
              placeholder="e.g. 37.5"
            />
          </Field>
        )}

        <Field
          label="Rating"
          htmlFor="media-rating"
          error={errors.rating}
          hint="Optional. 1–10, halves allowed."
        >
          <div className="flex items-center gap-2">
            <input
              id="media-rating"
              type="number"
              inputMode="decimal"
              min={1}
              max={10}
              step={0.5}
              value={values.rating}
              onChange={(event) => updateField("rating", event.target.value)}
              aria-invalid={Boolean(errors.rating)}
              aria-describedby={errors.rating ? "media-rating-error" : undefined}
              className={inputClass(Boolean(errors.rating), "w-24")}
              placeholder="8.5"
            />
            <span className="text-sm text-muted-foreground">/ 10</span>
          </div>
        </Field>
      </div>

      <div className="flex items-center justify-end gap-2 pt-2">
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
          {initialValues ? "Save Changes" : `Add ${label}`}
        </button>
      </div>
    </form>
  );
}
