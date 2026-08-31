import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Shared text-input/select styling for the media forms (full and compact/catalog). */
export function inputClass(hasError: boolean, width = "w-full") {
  return cn(
    width,
    "rounded-md border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground outline-none transition-colors focus:ring-2",
    hasError
      ? "border-red-500 focus:border-red-500 focus:ring-red-500/25"
      : "border-border focus:border-accent focus:ring-accent/25",
  );
}

interface FieldProps {
  label: string;
  htmlFor: string;
  error?: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
}

export function Field({ label, htmlFor, error, hint, required, children }: FieldProps) {
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
