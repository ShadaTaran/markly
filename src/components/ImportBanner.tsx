"use client";

import { useEffect } from "react";
import { useAuth } from "@/components/AuthProvider";
import { useLocalImport } from "@/hooks/useLocalImport";

/**
 * Mounted once, globally (see layout.tsx), so it appears regardless of
 * which page a newly-signed-in user lands on. Renders nothing until
 * there's unimported local data for the signed-in user to offer.
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
      <div className="border-b border-border bg-surface">
        <div className="mx-auto max-w-6xl px-4 py-2.5 text-sm text-foreground sm:px-6 lg:px-8">
          Imported {itemLabel} into your account.
        </div>
      </div>
    );
  }

  return (
    <div className="border-b border-border bg-surface">
      <div className="mx-auto flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 text-sm sm:px-6 lg:px-8">
        <p className="text-foreground">
          We found {itemLabel} stored on this device. Import them into your Markly account so they can sync across
          devices?
        </p>
        <div className="flex shrink-0 items-center gap-3">
          {error && <span className="text-xs text-red-500">{error}</span>}
          <button
            type="button"
            onClick={dismiss}
            disabled={status === "importing"}
            className="rounded-md px-2.5 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground disabled:opacity-60"
          >
            Not now
          </button>
          <button
            type="button"
            onClick={runImport}
            disabled={status === "importing"}
            className="rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background transition-colors hover:bg-foreground/85 disabled:opacity-60"
          >
            {status === "importing" ? "Importing…" : `Import ${itemLabel}`}
          </button>
        </div>
      </div>
    </div>
  );
}
