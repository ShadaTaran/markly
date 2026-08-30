"use client";

import { useId, useState, type FormEvent, type ReactNode } from "react";
import type { Bookmark, BookmarkInput } from "@/types/bookmark";
import { cn, isValidUrl, normalizeUrl, parseTags } from "@/lib/utils";

interface BookmarkFormProps {
  initialValues?: Bookmark;
  existingCategories: string[];
  onSubmit: (values: BookmarkInput) => void;
  onCancel: () => void;
}

interface FormState {
  title: string;
  url: string;
  description: string;
  category: string;
  tags: string;
}

type FormErrors = Partial<Record<"title" | "url" | "category", string>>;

function toFormState(bookmark?: Bookmark): FormState {
  return {
    title: bookmark?.title ?? "",
    url: bookmark?.url ?? "",
    description: bookmark?.description ?? "",
    category: bookmark?.category ?? "",
    tags: bookmark?.tags.join(", ") ?? "",
  };
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

export function BookmarkForm({
  initialValues,
  existingCategories,
  onSubmit,
  onCancel,
}: BookmarkFormProps) {
  const [values, setValues] = useState<FormState>(() => toFormState(initialValues));
  const [errors, setErrors] = useState<FormErrors>({});
  const datalistId = useId();

  function updateField<K extends keyof FormState>(field: K, value: string) {
    setValues((prev) => ({ ...prev, [field]: value }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();

    const normalizedUrl = normalizeUrl(values.url);
    const nextErrors: FormErrors = {};

    if (!values.title.trim()) nextErrors.title = "Title is required.";
    if (!values.url.trim()) nextErrors.url = "URL is required.";
    else if (!isValidUrl(normalizedUrl)) nextErrors.url = "Enter a valid URL, e.g. github.com";
    if (!values.category.trim()) nextErrors.category = "Category is required.";

    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }

    onSubmit({
      title: values.title.trim(),
      url: normalizedUrl,
      description: values.description.trim(),
      category: values.category.trim(),
      tags: parseTags(values.tags),
    });
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-4">
      <Field label="Title" htmlFor="bookmark-title" error={errors.title} required>
        <input
          id="bookmark-title"
          type="text"
          value={values.title}
          onChange={(event) => updateField("title", event.target.value)}
          aria-invalid={Boolean(errors.title)}
          aria-describedby={errors.title ? "bookmark-title-error" : undefined}
          className={inputClass(Boolean(errors.title))}
          placeholder="e.g. GitHub"
        />
      </Field>

      <Field label="URL" htmlFor="bookmark-url" error={errors.url} required>
        <input
          id="bookmark-url"
          type="text"
          value={values.url}
          onChange={(event) => updateField("url", event.target.value)}
          aria-invalid={Boolean(errors.url)}
          aria-describedby={errors.url ? "bookmark-url-error" : undefined}
          className={inputClass(Boolean(errors.url))}
          placeholder="e.g. github.com"
        />
      </Field>

      <Field label="Description" htmlFor="bookmark-description">
        <textarea
          id="bookmark-description"
          value={values.description}
          onChange={(event) => updateField("description", event.target.value)}
          rows={3}
          className={cn(inputClass(false), "resize-none")}
          placeholder="What is this site for?"
        />
      </Field>

      <Field label="Category" htmlFor="bookmark-category" error={errors.category} required>
        <input
          id="bookmark-category"
          type="text"
          list={datalistId}
          value={values.category}
          onChange={(event) => updateField("category", event.target.value)}
          aria-invalid={Boolean(errors.category)}
          aria-describedby={errors.category ? "bookmark-category-error" : undefined}
          className={inputClass(Boolean(errors.category))}
          placeholder="e.g. Development"
        />
        <datalist id={datalistId}>
          {existingCategories.map((category) => (
            <option key={category} value={category} />
          ))}
        </datalist>
      </Field>

      <Field label="Tags" htmlFor="bookmark-tags" hint="Separate tags with commas.">
        <input
          id="bookmark-tags"
          type="text"
          value={values.tags}
          onChange={(event) => updateField("tags", event.target.value)}
          className={inputClass(false)}
          placeholder="e.g. design, ui, tools"
        />
      </Field>

      <div className="flex items-center justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-border px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          Cancel
        </button>
        <button
          type="submit"
          className="rounded-md bg-foreground px-3.5 py-2 text-sm font-medium text-background transition-colors hover:bg-foreground/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          {initialValues ? "Save Changes" : "Add Bookmark"}
        </button>
      </div>
    </form>
  );
}
