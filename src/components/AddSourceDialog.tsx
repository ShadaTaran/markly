"use client";

import { useId, useState, type FormEvent } from "react";
import { isValidUrl, normalizeUrl, getDomain } from "@/lib/website";
import { Dialog } from "@/components/Dialog";
import { Field, inputClass } from "@/components/FormField";
import { Button } from "@/components/Button";

export type AddSourceOutcome =
  | { status: "created" | "linked"; sourceId: string }
  | { status: "already-linked"; sourceId: string }
  | { status: "conflict"; sourceId: string; conflictingLibraryItemId: string };

interface AddSourceDialogProps {
  isOpen: boolean;
  libraryItemId: string;
  onClose: () => void;
  onLinked: (outcome: AddSourceOutcome) => void;
}

/**
 * Stage 40 — "Add Source": paste a URL, validate, preview, optionally label
 * it, confirm. No auto-add on paste, no clipboard read — a plain input the
 * user types or pastes into themselves, submitted only by explicit click
 * (Stage 40 §6/§26). Reuses the exact same URL policy the manual Website
 * Add form and Stage 39's capture flow already enforce (lib/website.ts) —
 * no second validator.
 *
 * Deliberately does not accept or send a `mediaType` — the server derives
 * the item's real type itself from `libraryItemId` (see the /api/tracking-
 * sources route and createManualSource's own doc comment on why a client-
 * declared type was a genuine data-integrity gap, not just redundant).
 */
export function AddSourceDialog({ isOpen, libraryItemId, onClose, onLinked }: AddSourceDialogProps) {
  const urlFieldId = useId();
  const labelFieldId = useId();
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);

  const trimmedUrl = url.trim();
  const normalized = trimmedUrl ? normalizeUrl(trimmedUrl) : "";
  const preview = trimmedUrl && isValidUrl(normalized) ? getDomain(normalized) : null;

  function handleClose() {
    setUrl("");
    setLabel("");
    setError(undefined);
    setSubmitting(false);
    onClose();
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;

    if (!trimmedUrl) {
      setError("Enter a link.");
      return;
    }
    if (!isValidUrl(normalized)) {
      setError("This link can't be used. Markly accepts normal http and https links.");
      return;
    }

    setSubmitting(true);
    setError(undefined);
    try {
      const response = await fetch("/api/tracking-sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ libraryItemId, url: normalized, label: label.trim() || undefined }),
      });
      const outcome = (await response.json().catch(() => null)) as AddSourceOutcome | { error: string } | null;
      if (!response.ok || !outcome || "error" in outcome) {
        setError("Couldn't add that source. Try again.");
        return;
      }
      onLinked(outcome);
      handleClose();
    } catch {
      setError("Couldn't add that source. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog isOpen={isOpen} onClose={handleClose} title="Add source" widthClassName="max-w-sm">
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <Field label="Link" htmlFor={urlFieldId} error={error} hint={preview ? `Links to ${preview}` : "e.g. mangadex.org/title/…"}>
          <input
            id={urlFieldId}
            type="text"
            value={url}
            onChange={(event) => {
              setUrl(event.target.value);
              setError(undefined);
            }}
            placeholder="Paste a link"
            autoFocus
            className={inputClass(Boolean(error))}
          />
        </Field>

        <Field label="Label (optional)" htmlFor={labelFieldId} hint='e.g. "MangaDex" or "Official site"'>
          <input
            id={labelFieldId}
            type="text"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder={preview ?? undefined}
            className={inputClass(false)}
          />
        </Field>

        <div className="flex items-center justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={handleClose} type="button">
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={submitting}>
            {submitting ? "Adding…" : "Add source"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
