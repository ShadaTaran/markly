"use client";

import { useId, useState, type FormEvent, type ReactNode } from "react";
import type { MediaItem, MediaItemInput } from "@/types/library-item";
import { ITEM_TYPE_LABELS } from "@/types/library-item";
import { cn, parseTags } from "@/lib/utils";
import { isValidUrl, normalizeUrl } from "@/lib/website";

interface MediaItemFormProps {
  type: MediaItem["type"];
  initialValues?: MediaItem;
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
}

type FormErrors = Partial<Record<"title" | "category" | "imageUrl" | "sourceUrl", string>>;

function toFormState(item?: MediaItem): FormState {
  return {
    title: item?.title ?? "",
    description: item?.description ?? "",
    imageUrl: item?.imageUrl ?? "",
    sourceUrl: item?.sourceUrl ?? "",
    category: item?.category ?? "",
    tags: item?.tags.join(", ") ?? "",
    platform: item && item.type === "game" ? (item.platform ?? "") : "",
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

function inputClass(hasError: boolean) {
  return cn(
    "w-full rounded-md border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground outline-none transition-colors focus:ring-2",
    hasError
      ? "border-red-500 focus:border-red-500 focus:ring-red-500/25"
      : "border-border focus:border-accent focus:ring-accent/25",
  );
}

function Field({
  label,
  htmlFor,
  error,
  hint,
  required,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1.5 block text-sm font-medium text-foreground">
        {label}
        {required && (
          <span className="ml-0.5 text-muted-foreground" aria-hidden="true">
            *
          </span>
        )}
      </label>
      {children}
      {error ? (
        <p id={`${htmlFor}-error`} className="mt-1.5 text-xs text-red-500">
          {error}
        </p>
      ) : hint ? (
        <p className="mt-1.5 text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

export function MediaItemForm({
  type,
  initialValues,
  existingCategories,
  onSubmit,
  onCancel,
}: MediaItemFormProps) {
  const [values, setValues] = useState<FormState>(() => toFormState(initialValues));
  const [errors, setErrors] = useState<FormErrors>({});
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

    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }

    const common = {
      title: values.title.trim(),
      description: values.description.trim(),
      category: values.category.trim(),
      tags: parseTags(values.tags),
      imageUrl: emptyToUndefined(image.value),
      sourceUrl: emptyToUndefined(source.value),
    };

    if (type === "game") {
      onSubmit({ ...common, platform: emptyToUndefined(values.platform) });
    } else {
      onSubmit(common);
    }
  }

  const label = ITEM_TYPE_LABELS[type];

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
