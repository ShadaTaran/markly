"use client";

import { useEffect } from "react";
import { useAuth } from "@/components/AuthProvider";
import { useLocalImport } from "@/hooks/useLocalImport";
import { IconButton } from "@/components/IconButton";
import { XIcon } from "@/components/icons";

/**
 * Rendered by each top-level page, directly under its own Header — a
 * one-time, per-device nudge, not permanent app chrome, so it must never
 * outrank navigation. "Not now" persists (see useLocalImport), so it does
 * not resurface it on every visit; the underlying local data and the
 * ability to import it later from Settings > Data & Backup are unaffected
 * either way (Stage 16 import safety is untouched here — this only
 * changes whether this notice is shown).
 */
export function ImportBanner() {
  const { user } = useAuth();
  const { available, summary, status, error, runImport, dismiss } = useLocalImport(user?.id ?? null);

  // After a successful import, every cloud-aware hook on the page needs to
  // re-fetch from the now-populated database. A full reload is the
  // simplest reliable way to do that across every mounted view at once,
  // for what is a rare, one-time action.
  useEffect(() => {
    if (status !== "done") return;
    const timeout = setTimeout(() => window.location.reload(), 900);
    return () => clearTimeout(timeout);
  }, [status]);

  if (!available || !summary) return null;

  const itemLabel = `${summary.itemCount} item${summary.itemCount === 1 ? "" : "s"}`;

  if (status === "done") {
    return (
      <div className="border-b border-border bg-muted">
        <div className="mx-auto max-w-6xl px-4 py-1.5 text-xs text-muted-foreground sm:px-6 lg:px-8">
          Imported {itemLabel} into your account.
        </div>
      </div>
    );
  }

  return (
    <div className="border-b border-border bg-muted">
      <div className="mx-auto flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-1.5 text-xs sm:px-6 lg:px-8">
        <span className="text-muted-foreground">
          {itemLabel} found on this device.
          {error && <span className="ml-2 text-danger">{error}</span>}
        </span>
        <button
          type="button"
          onClick={runImport}
          disabled={status === "importing"}
          className="shrink-0 font-medium text-accent transition-opacity hover:underline disabled:opacity-60"
        >
          {status === "importing" ? "Importing…" : "Import to sync across devices"}
        </button>
        <IconButton
          aria-label="Dismiss import notice"
          icon={<XIcon width={13} height={13} />}
          onClick={dismiss}
          disabled={status === "importing"}
          className="ml-auto -my-1.5 shrink-0"
        />
      </div>
    </div>
  );
}
