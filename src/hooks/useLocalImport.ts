"use client";

import { useEffect, useState } from "react";
import { getSupabaseClient } from "@/lib/supabase/client";
import {
  hasCompletedMigration,
  migrateLocalDataToCloud,
  readLocalDataSummary,
  type LocalDataSummary,
} from "@/lib/cloud/migration";

export type ImportStatus = "idle" | "importing" | "done" | "error";

const DISMISS_FLAG_PREFIX = "markly.import-banner-dismissed.";

function isDismissed(userId: string): boolean {
  try {
    return localStorage.getItem(DISMISS_FLAG_PREFIX + userId) === "1";
  } catch {
    return false;
  }
}

function persistDismissed(userId: string) {
  try {
    localStorage.setItem(DISMISS_FLAG_PREFIX + userId, "1");
  } catch {
    // Best-effort only — worst case the notice reappears next visit.
  }
}

/** Detects whether this signed-in user has not-yet-imported local data on this device, and drives the import action. */
export function useLocalImport(userId: string | null) {
  const [summary, setSummary] = useState<LocalDataSummary | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [status, setStatus] = useState<ImportStatus>("idle");
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resets this hook's local UI state (dismissal, import status) whenever the signed-in user identity changes, so a previous account's dismissal/status never leaks into the next one.
    setStatus("idle");
    setError(undefined);

    if (!userId || hasCompletedMigration(userId)) {
      setSummary(null);
      setDismissed(false);
      return;
    }
    setSummary(readLocalDataSummary());
    setDismissed(isDismissed(userId));
  }, [userId]);

  async function runImport() {
    if (!userId) return;
    const supabase = getSupabaseClient();
    if (!supabase) {
      setStatus("error");
      setError("Cloud sync isn't configured for this deployment.");
      return;
    }

    setStatus("importing");
    setError(undefined);
    const result = await migrateLocalDataToCloud(supabase, userId);
    if (result.success) {
      setStatus("done");
    } else {
      setStatus("error");
      setError(result.error);
    }
  }

  function dismiss() {
    setDismissed(true);
    if (userId) persistDismissed(userId);
  }

  return {
    available: Boolean(summary) && !dismissed,
    /** True whenever unimported local data exists, regardless of banner dismissal — for a quieter, always-discoverable affordance (e.g. in Settings). */
    hasPendingImport: Boolean(summary),
    summary,
    status,
    error,
    runImport,
    dismiss,
  };
}
