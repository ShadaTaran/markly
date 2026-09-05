"use client";

import { useRef, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { useLibraryItems } from "@/hooks/useLibraryItems";
import { useCollections } from "@/hooks/useCollections";
import { useActivity } from "@/hooks/useActivity";
import { getSupabaseClient } from "@/lib/supabase/client";
import { DataErrorBanner } from "@/components/DataStatus";
import { buildAndValidateBackup } from "@/lib/backup/export";
import { fetchActivityEventsForExport } from "@/lib/cloud/backup";
import { downloadBackupFile } from "@/lib/backup/download";
import { validateBackupFile, type ValidatedBackup } from "@/lib/backup/validate";
import { MAX_BACKUP_FILE_SIZE_BYTES } from "@/lib/backup/limits";
import { buildImportPlan, type ImportPlan } from "@/lib/backup/plan";
import { applyImportPlanLocally, computeLocalActivityRetention } from "@/lib/backup/apply-local";
import { importLibraryBackup } from "@/lib/cloud/backup-import";
import { fetchLibraryItems } from "@/lib/cloud/library-items";
import { fetchCollections } from "@/lib/cloud/collections";
import { formatDate } from "@/lib/item-detail";
import { MAX_ACTIVITY_EVENTS } from "@/lib/activity-storage";
import type { ActivityEvent } from "@/types/activity";

/**
 * Local-mode preview estimate of Stage 29 Part B's capacity trim — see
 * apply-local.ts's `computeLocalActivityRetention` doc comment. Uses
 * placeholder `{id, timestamp}` records (never real ActivityEvent objects
 * — backup-local item ids aren't resolved to real ones until apply time)
 * so the preview can reuse the EXACT SAME trim function the apply step
 * uses, guaranteeing the count shown here is the count that survives.
 * Callers only invoke this in local mode (cloud mode hardcodes 0 — see
 * B5) since it estimates against the local 500-event cap specifically.
 */
function estimateLocalActivitySkippedForCapacity(currentEvents: ActivityEvent[], candidateTimestamps: string[]): number {
  const placeholders = candidateTimestamps.map((timestamp, index) => ({ id: `preview-${index}`, timestamp }));
  return computeLocalActivityRetention(currentEvents, placeholders, MAX_ACTIVITY_EVENTS).skippedForCapacity;
}

/**
 * Stage 29 — Settings > Data & Backup. Handles both signed-out (local)
 * and signed-in (cloud) modes; see README "Portable Backup, Export &
 * Import" for the full design this implements.
 */

type ImportState =
  | { step: "idle" }
  | { step: "validating" }
  | { step: "invalid"; message: string }
  | {
      step: "preview";
      validated: ValidatedBackup;
      plan: ImportPlan;
      includePossibleDuplicates: boolean;
      /** Local mode only (always 0 in cloud mode — see B5) — an estimate of `plan.counts.activityImport` that Part B's local history cap would additionally skip. */
      activitySkippedForCapacity: number;
    }
  | { step: "importing" }
  | {
      step: "done";
      itemsCreated: number;
      /** Cloud mode only — a "new" item that turned out to already exist by the time the server ran (0014's concurrency-safety revalidation, e.g. another in-flight import for the same account). Always 0 in local mode, which has no concurrent-transaction race to guard against. */
      itemsReused: number;
      collectionsCreated: number;
      collectionsReused: number;
      activityCreated: number;
      possibleDuplicatesSkipped: number;
      /** Local mode only — how many otherwise-importable Activity events didn't survive the local history cap. Always 0 in cloud mode. */
      activitySkippedForCapacity: number;
    }
  | { step: "error"; message: string };

export function BackupSettingsPanel() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const activity = useActivity(userId);
  const library = useLibraryItems([], activity.logEvent, userId);
  const collectionsStore = useCollections(library.items, library.isHydrated, userId);

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [importState, setImportState] = useState<ImportState>({ step: "idle" });
  const fileInputRef = useRef<HTMLInputElement>(null);

  const notHydrated = Boolean(userId) && (!library.isHydrated || !collectionsStore.isHydrated || !activity.isHydrated);

  async function handleExport() {
    setExportError(null);
    setExporting(true);
    try {
      if (userId) {
        const supabase = getSupabaseClient();
        if (!supabase) throw new Error("Cloud sync isn't configured for this deployment.");
        // Fresh, uncapped fetches — never the app's already-loaded state,
        // which for Activity is capped at the Recent Activity display
        // limit (see lib/cloud/backup.ts's doc comment).
        const [items, collections, allEvents] = await Promise.all([
          fetchLibraryItems(supabase, userId),
          fetchCollections(supabase, userId),
          fetchActivityEventsForExport(supabase, userId),
        ]);
        const result = buildAndValidateBackup(items, collections, allEvents);
        if (!result.ok || !result.backup) throw new Error("Could not prepare a valid backup. Please try again.");
        downloadBackupFile(result.backup);
        return;
      }

      const result = buildAndValidateBackup(library.items, collectionsStore.collections, activity.events);
      if (!result.ok || !result.backup) throw new Error("Could not prepare a valid backup. Please try again.");
      downloadBackupFile(result.backup);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : "Couldn't export your backup. Try again.");
    } finally {
      setExporting(false);
    }
  }

  async function handleFileChosen(file: File) {
    setImportState({ step: "validating" });
    const result = await validateBackupFile(file, { maxFileSizeBytes: MAX_BACKUP_FILE_SIZE_BYTES });
    if (!result.ok) {
      setImportState({ step: "invalid", message: result.message });
      return;
    }
    const plan = buildImportPlan(result.backup, library.items, collectionsStore.collections, { includePossibleDuplicates: false });
    const activitySkippedForCapacity = userId
      ? 0
      : estimateLocalActivitySkippedForCapacity(
          activity.events,
          plan.activityToImport.map((e) => e.timestamp),
        );
    setImportState({ step: "preview", validated: result.backup, plan, includePossibleDuplicates: false, activitySkippedForCapacity });
  }

  function handleToggleIncludeDuplicates(checked: boolean) {
    if (importState.step !== "preview") return;
    const plan = buildImportPlan(importState.validated, library.items, collectionsStore.collections, { includePossibleDuplicates: checked });
    const activitySkippedForCapacity = userId
      ? 0
      : estimateLocalActivitySkippedForCapacity(
          activity.events,
          plan.activityToImport.map((e) => e.timestamp),
        );
    setImportState({ ...importState, plan, includePossibleDuplicates: checked, activitySkippedForCapacity });
  }

  async function handleConfirmImport() {
    if (importState.step !== "preview") return;
    const { plan } = importState;
    setImportState({ step: "importing" });

    try {
      if (userId) {
        const supabase = getSupabaseClient();
        if (!supabase) throw new Error("Cloud sync isn't configured for this deployment.");
        const result = await importLibraryBackup(supabase, plan);
        if (result.status !== "imported") {
          throw new Error(
            result.status === "duplicate_request"
              ? "This import was already submitted."
              : result.status === "plan_too_large"
                ? "This backup is too large to import."
                : "Couldn't import this backup. Try again.",
          );
        }
        await Promise.all([library.reload(), collectionsStore.reload(), activity.reload()]);
        setImportState({
          step: "done",
          itemsCreated: result.itemsCreated ?? 0,
          itemsReused: result.itemsReused ?? 0,
          collectionsCreated: result.collectionsCreated ?? 0,
          collectionsReused: result.collectionsReused ?? 0,
          activityCreated: result.activityCreated ?? 0,
          possibleDuplicatesSkipped: plan.counts.itemsPossibleDuplicate - plan.counts.itemsPossibleDuplicateIncluded,
          activitySkippedForCapacity: 0,
        });
        return;
      }

      const applied = applyImportPlanLocally(plan, library.items, collectionsStore.collections, activity.events);
      // All three in the same synchronous batch — see apply-local.ts's doc comment.
      collectionsStore.replaceAllLocal(applied.collections);
      activity.replaceAllLocal(applied.events);
      library.replaceAllLocal(applied.items);
      setImportState({
        step: "done",
        itemsCreated: plan.counts.itemsNew + plan.counts.itemsPossibleDuplicateIncluded,
        itemsReused: 0,
        collectionsCreated: plan.counts.collectionsNew,
        collectionsReused: plan.counts.collectionsReuse,
        activityCreated: applied.activityImportedCount,
        activitySkippedForCapacity: applied.activitySkippedForCapacity,
        possibleDuplicatesSkipped: plan.counts.itemsPossibleDuplicate - plan.counts.itemsPossibleDuplicateIncluded,
      });
    } catch (err) {
      setImportState({ step: "error", message: err instanceof Error ? err.message : "Couldn't import this backup. Try again." });
    }
  }

  function resetImport() {
    setImportState({ step: "idle" });
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  if (notHydrated) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-foreground">Export</h2>
        <p className="text-sm text-muted-foreground">
          {userId ? "Download a portable copy of your Markly cloud library." : "Download a portable copy of this device's local Markly library."}
        </p>
        <p className="text-xs text-muted-foreground">Your backup contains your Markly library data. Store it somewhere you trust.</p>
        {exportError && <DataErrorBanner message={exportError} onRetry={() => setExportError(null)} />}
        <button
          type="button"
          onClick={handleExport}
          disabled={exporting}
          className="rounded-md bg-foreground px-3.5 py-2 text-sm font-medium text-background transition-colors hover:bg-foreground/85 disabled:opacity-50"
        >
          {exporting ? "Preparing…" : "Export backup"}
        </button>
      </section>

      <section className="space-y-3 border-t border-border pt-6">
        <h2 className="text-sm font-semibold text-foreground">Import</h2>
        <p className="text-sm text-muted-foreground">Restore or add data from a Markly backup. Nothing changes until you confirm.</p>
        <p className="text-xs text-muted-foreground">Automatic tracking connections are not included in backups.</p>

        {importState.step === "idle" && (
          <label className="inline-block cursor-pointer rounded-md border border-border px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-surface-hover">
            Choose backup file
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleFileChosen(file);
              }}
            />
          </label>
        )}

        {importState.step === "validating" && <p className="text-sm text-muted-foreground">Checking backup…</p>}

        {importState.step === "invalid" && (
          <div className="space-y-3">
            <DataErrorBanner message={importState.message} onRetry={resetImport} />
          </div>
        )}

        {importState.step === "error" && (
          <div className="space-y-3">
            <DataErrorBanner message={importState.message} onRetry={resetImport} />
          </div>
        )}

        {importState.step === "preview" && (
          <ImportPreview
            validated={importState.validated}
            plan={importState.plan}
            includePossibleDuplicates={importState.includePossibleDuplicates}
            activitySkippedForCapacity={importState.activitySkippedForCapacity}
            onToggleIncludeDuplicates={handleToggleIncludeDuplicates}
            onCancel={resetImport}
            onConfirm={handleConfirmImport}
          />
        )}

        {importState.step === "importing" && <p className="text-sm text-muted-foreground">Importing…</p>}

        {importState.step === "done" && (
          <div className="space-y-2 rounded-md border border-border bg-surface p-4">
            <p className="text-sm font-medium text-foreground">Import complete</p>
            <ul className="space-y-1 text-sm text-muted-foreground">
              <li>{importState.itemsCreated} items added</li>
              {importState.itemsReused > 0 && (
                <li>{importState.itemsReused} items were already added by another in-progress import</li>
              )}
              {importState.collectionsCreated > 0 && <li>{importState.collectionsCreated} collections created</li>}
              {importState.collectionsReused > 0 && <li>{importState.collectionsReused} existing collections reused</li>}
              {importState.activityCreated > 0 && <li>{importState.activityCreated} Activity events restored</li>}
              {importState.activitySkippedForCapacity > 0 && (
                <li>{importState.activitySkippedForCapacity} older Activity events skipped due to this device&rsquo;s local history limit</li>
              )}
              {importState.possibleDuplicatesSkipped > 0 && (
                <li>{importState.possibleDuplicatesSkipped} possible duplicates skipped — review them from the Library page</li>
              )}
            </ul>
            <button type="button" onClick={resetImport} className="mt-2 text-xs font-medium text-accent hover:underline">
              Import another backup
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

interface ImportPreviewProps {
  validated: ValidatedBackup;
  plan: ImportPlan;
  includePossibleDuplicates: boolean;
  /** Local mode only — see BackupSettingsPanel's `estimateLocalActivitySkippedForCapacity`. Always 0 in cloud mode (B5). */
  activitySkippedForCapacity: number;
  onToggleIncludeDuplicates: (checked: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
}

function ImportPreview({ validated, plan, includePossibleDuplicates, activitySkippedForCapacity, onToggleIncludeDuplicates, onCancel, onConfirm }: ImportPreviewProps) {
  const exportedLabel = formatDate(validated.exportedAt) ?? "an unknown date";
  const { counts } = plan;

  return (
    <div className="space-y-4 rounded-md border border-border bg-surface p-4">
      <div>
        <p className="text-sm font-medium text-foreground">Markly Backup</p>
        <p className="text-xs text-muted-foreground">Exported {exportedLabel}</p>
      </div>

      <div className="grid grid-cols-3 gap-3 text-sm">
        <div>
          <p className="text-muted-foreground">Library Items</p>
          <p className="font-medium text-foreground">{validated.libraryItems.length}</p>
        </div>
        <div>
          <p className="text-muted-foreground">Collections</p>
          <p className="font-medium text-foreground">{validated.collections.length}</p>
        </div>
        <div>
          <p className="text-muted-foreground">Activity</p>
          <p className="font-medium text-foreground">{validated.activityEvents.length}</p>
        </div>
      </div>

      <div className="space-y-1 border-t border-border pt-3 text-sm">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground/70">Import plan</p>
        <p className="text-foreground">{counts.itemsNew + counts.itemsPossibleDuplicateIncluded} new</p>
        <p className="text-muted-foreground">{counts.itemsAlreadyPresent} already present</p>
        <p className="text-muted-foreground">
          {counts.itemsPossibleDuplicate} possible duplicate{counts.itemsPossibleDuplicate === 1 ? "" : "s"}
          {!includePossibleDuplicates && counts.itemsPossibleDuplicate > 0 ? " — these will be skipped" : ""}
        </p>
        {(counts.collectionsNew > 0 || counts.collectionsReuse > 0) && (
          <p className="text-muted-foreground">
            Collections: {counts.collectionsNew} new, {counts.collectionsReuse} reused
          </p>
        )}
        <p className="text-muted-foreground">
          Activity: {counts.activityImport - activitySkippedForCapacity} to restore, {counts.activitySkipped} not applicable
          {activitySkippedForCapacity > 0 ? `, ${activitySkippedForCapacity} skipped due to local history limit` : ""}
        </p>
      </div>

      {counts.itemsPossibleDuplicate > 0 && (
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            checked={includePossibleDuplicates}
            onChange={(e) => onToggleIncludeDuplicates(e.target.checked)}
            className="h-4 w-4 rounded border-border"
          />
          Import possible duplicates too (as separate new items)
        </label>
      )}

      {(validated.skipped.libraryItems > 0 || validated.skipped.collections > 0 || validated.skipped.activityEvents > 0) && (
        <p className="text-xs text-muted-foreground">
          {validated.skipped.libraryItems + validated.skipped.collections + validated.skipped.activityEvents} record(s) in this file
          couldn&rsquo;t be read and were skipped.
        </p>
      )}

      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-border px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-surface-hover"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="rounded-md bg-foreground px-3.5 py-2 text-sm font-medium text-background transition-colors hover:bg-foreground/85"
        >
          Import
        </button>
      </div>
    </div>
  );
}
