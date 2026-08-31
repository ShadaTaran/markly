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

/** Detects whether this signed-in user has not-yet-imported local data on this device, and drives the import action. */
export function useLocalImport(userId: string | null) {
  const [summary, setSummary] = useState<LocalDataSummary | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [status, setStatus] = useState<ImportStatus>("idle");
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resets this hook's local UI state (dismissal, import status) whenever the signed-in user identity changes, so a previous account's dismissal/status never leaks into the next one.
    setDismissed(false);
    setStatus("idle");
    setError(undefined);

    if (!userId || hasCompletedMigration(userId)) {
      setSummary(null);
      return;
    }
    setSummary(readLocalDataSummary());
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
  }

  return {
    available: Boolean(summary) && !dismissed,
    summary,
    status,
    error,
    runImport,
    dismiss,
  };
}
