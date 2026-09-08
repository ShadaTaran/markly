"use client";

import { useState, type FormEvent } from "react";
import { Dialog } from "@/components/Dialog";
import { Field, inputClass } from "@/components/FormField";
import { Button } from "@/components/Button";

interface SaveSmartViewDialogProps {
  mode: "create" | "rename";
  isOpen: boolean;
  initialName?: string;
  /** Surfaced by the parent after a createView/updateView call returns duplicate_name/invalid_name/error — this dialog never validates duplicates itself since that requires the caller's up-to-date view list. */
  externalError?: string;
  onSubmit: (name: string) => void;
  onClose: () => void;
}

/** Name-entry dialog for both "Save as Smart View" and "Rename view" — mirrors CollectionDialog's exact form pattern (Stage 31 §22/§23/§25). */
export function SaveSmartViewDialog({ mode, isOpen, initialName, externalError, onSubmit, onClose }: SaveSmartViewDialogProps) {
  const [name, setName] = useState(initialName ?? "");

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    onSubmit(name);
  }

  return (
    <Dialog isOpen={isOpen} onClose={onClose} title={mode === "rename" ? "Rename View" : "Save as Smart View"} widthClassName="max-w-sm">
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <Field label="View name" htmlFor="smart-view-name" error={externalError} required>
          <input
            id="smart-view-name"
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            aria-invalid={Boolean(externalError)}
            aria-describedby={externalError ? "smart-view-name-error" : undefined}
            className={inputClass(Boolean(externalError))}
            placeholder="e.g. Reading Manga"
            autoFocus
          />
        </Field>

        <div className="flex items-center justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary">
            {mode === "rename" ? "Save Name" : "Save View"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
