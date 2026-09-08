"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { LatestRequestGuard } from "@/lib/latest-request-guard";
import type { FieldReconciliation, ItemReconciliation, SyncDirection } from "@/lib/integrations/anilist/reconciliation";
import type { WritebackPreview, WritebackPreviewItem, ApplyPlanItem, ApplyItemResult } from "@/lib/integrations/anilist/writeback";

/**
 * Stage 30 — the reconciliation preview/apply dialog behind "Sync Now".
 * Preview is read-only (fetched once on open); nothing is sent to
 * AniList or written to Markly until the user explicitly presses "Apply
 * selected changes" (§55/§56 — Cancel and closing this dialog are both
 * zero-mutation). Copy deliberately avoids implying automatic/background
 * sync (§85) — every field choice is the user's own.
 */

interface AniListReconcilePanelProps {
  onClose: () => void;
  onApplied: () => void;
}

type FieldKey = "progress" | "status" | "rating";
type Choice = SyncDirection | "none";

interface ItemSelection {
  progress: Choice;
  status: Choice;
  rating: Choice;
}

type PanelState =
  | { step: "loading" }
  | { step: "error"; message: string }
  | { step: "preview"; preview: WritebackPreview; selections: Record<string, ItemSelection> }
  | { step: "applying" }
  | { step: "results"; results: ApplyItemResult[]; changedWhileReviewing: number; needsAttention: number };

function defaultSelection(fields: ItemReconciliation["fields"]): ItemSelection {
  return {
    progress: fields.progress.suggestedDirection,
    status: fields.status.suggestedDirection,
    rating: fields.rating.suggestedDirection,
  };
}

function progressLabel(item: ItemReconciliation, value: number | undefined): string {
  if (value === undefined) return "—";
  if (item.type === "manga") return `Chapter ${value}`;
  return `Episode ${value}`;
}

function ratingLabel(value: number | undefined): string {
  return value === undefined ? "Unrated" : `${value}/10`;
}

function statusLabel(value: string | undefined): string {
  if (!value) return "—";
  const labels: Record<string, string> = { planned: "Planned", in_progress: "In Progress", completed: "Completed", on_hold: "On Hold", dropped: "Dropped" };
  return labels[value] ?? value;
}

const UNSUPPORTED_COPY: Record<string, string> = {
  seasonal_numbering: "Can’t automatically map seasonal episode numbering to AniList’s absolute progress.",
  fractional_progress: "This chapter progress can’t be represented exactly on AniList.",
  type_unsupported: "This item type isn’t supported for AniList sync yet.",
};

function fieldHasChoices(field: FieldReconciliation<unknown>): boolean {
  return field.allowedDirections.length > 0;
}

/**
 * Radio group identity for one item's one field's direction choice.
 * MUST be scoped by itemId + field, never by displayed label/local/remote
 * text — two different items can easily show identical text (e.g. two
 * items both "Status: In Progress -> —"), and native `<input
 * name="...">` grouping is global across the whole document regardless
 * of React component boundaries. A collision here doesn't just look
 * wrong: selecting one item's field can native-uncheck a DIFFERENT
 * item's radio, live-observed to almost leave a stray field selected
 * for outbound sync on an item the user never touched.
 */
export function buildReconciliationRadioGroupName(itemId: string, field: FieldKey): string {
  return `anilist-sync-${itemId}-${field}`;
}

export function AniListReconcilePanel({ onClose, onApplied }: AniListReconcilePanelProps) {
  const [state, setState] = useState<PanelState>({ step: "loading" });

  // Guards against overlapping preview requests (dev Strict Mode's double effect-invoke,
  // a fast retry while a prior request is still in flight, or requests simply resolving
  // out of order) — see LatestRequestGuard. Only the request that is still current at
  // resolution time is allowed to touch state; cancelling on cleanup aborts whatever is
  // in flight (a real unmount, or Strict Mode's simulated one — the guard itself is never
  // permanently disabled, so its second effect invocation still resolves normally).
  const requestGuardRef = useRef<LatestRequestGuard | null>(null);
  if (requestGuardRef.current === null) requestGuardRef.current = new LatestRequestGuard();

  useEffect(() => {
    const guard = requestGuardRef.current!;
    void loadPreview();
    return () => guard.cancel();
  }, []);

  async function loadPreview() {
    const guard = requestGuardRef.current!;
    const token = guard.start();

    setState({ step: "loading" });
    try {
      const response = await fetch("/api/integrations/anilist/reconcile/preview", { signal: token.signal });
      const data = await response.json();
      if (!guard.isCurrent(token)) return;
      if (!response.ok) {
        setState({ step: "error", message: errorMessageFor(data.error) });
        return;
      }
      const preview = data as WritebackPreview;
      const selections: Record<string, ItemSelection> = {};
      preview.items.forEach((entry) => {
        selections[entry.reconciliation.itemId] = defaultSelection(entry.reconciliation.fields);
      });
      setState({ step: "preview", preview, selections });
    } catch (err) {
      if (!guard.isCurrent(token)) return;
      if (err instanceof DOMException && err.name === "AbortError") return;
      setState({ step: "error", message: "AniList could not be reached. Nothing was changed." });
    }
  }

  function setChoice(itemId: string, field: FieldKey, choice: Choice) {
    if (state.step !== "preview") return;
    setState({ ...state, selections: { ...state.selections, [itemId]: { ...state.selections[itemId], [field]: choice } } });
  }

  const changedCount = useMemo(() => {
    if (state.step !== "preview") return 0;
    return Object.values(state.selections).filter((sel) => sel.progress !== "none" || sel.status !== "none" || sel.rating !== "none").length;
  }, [state]);

  async function apply() {
    if (state.step !== "preview") return;
    const plan: ApplyPlanItem[] = [];
    for (const entry of state.preview.items) {
      const selection = state.selections[entry.reconciliation.itemId];
      if (selection.progress === "none" && selection.status === "none" && selection.rating === "none") continue;
      plan.push(buildPlanItem(entry, selection));
    }
    if (plan.length === 0) return;

    setState({ step: "applying" });
    try {
      const response = await fetch("/api/integrations/anilist/reconcile/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan }),
      });
      const data = await response.json();
      if (!response.ok) {
        setState({ step: "error", message: errorMessageFor(data.error) });
        return;
      }
      const results = data.results as ApplyItemResult[];
      const changedWhileReviewing = results.filter((r) => r.status === "local_changed_since_preview" || r.status === "remote_changed_since_preview").length;
      const needsAttention = results.filter((r) => r.status !== "applied" && r.status !== "local_changed_since_preview" && r.status !== "remote_changed_since_preview").length;
      setState({ step: "results", results, changedWhileReviewing, needsAttention });
      onApplied();
    } catch {
      setState({ step: "error", message: "AniList could not be reached. Some changes may not have been applied — reopen Sync Now to check." });
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label="AniList Sync">
      <div className="flex max-h-[90vh] w-full flex-col overflow-hidden rounded-t-lg border border-border bg-surface sm:max-w-2xl sm:rounded-lg">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-base font-semibold text-foreground">AniList Sync</h2>
          <button type="button" onClick={onClose} className="rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-surface-hover hover:text-foreground" aria-label="Close">
            Close
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {state.step === "loading" && <p className="text-sm text-muted-foreground">Checking your AniList list…</p>}

          {state.step === "error" && (
            <div className="space-y-3">
              <p className="text-sm text-danger">{state.message}</p>
              <button type="button" onClick={loadPreview} className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-surface-hover">
                Try again
              </button>
            </div>
          )}

          {state.step === "preview" && <PreviewList preview={state.preview} selections={state.selections} onChoice={setChoice} />}

          {state.step === "applying" && <p className="text-sm text-muted-foreground">Applying selected changes…</p>}

          {state.step === "results" && <ResultsSummary results={state.results} changedWhileReviewing={state.changedWhileReviewing} needsAttention={state.needsAttention} onRefresh={loadPreview} />}
        </div>

        {state.step === "preview" && (
          <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-3">
            <p className="text-xs text-muted-foreground">
              Review changes between Markly and AniList and choose what to sync. Nothing changes until you apply.
            </p>
            <div className="flex shrink-0 gap-2">
              <button type="button" onClick={onClose} className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-surface-hover">
                Cancel
              </button>
              <button
                type="button"
                onClick={apply}
                disabled={changedCount === 0}
                className="rounded-md bg-foreground px-3.5 py-1.5 text-sm font-medium text-background hover:bg-foreground/85 disabled:opacity-50"
              >
                Apply {changedCount} change{changedCount === 1 ? "" : "s"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function buildPlanItem(entry: WritebackPreviewItem, selection: ItemSelection): ApplyPlanItem {
  return {
    itemId: entry.reconciliation.itemId,
    expectedMediaId: entry.reconciliation.mediaId,
    expectedLocalUpdatedAt: entry.expectedLocalUpdatedAt,
    expectedRemoteExists: entry.expectedRemote.exists,
    expectedRemoteStatus: entry.expectedRemote.status,
    expectedRemoteProgress: entry.expectedRemote.progress,
    expectedRemoteScore: entry.expectedRemote.score,
    changes: { progress: selection.progress, status: selection.status, rating: selection.rating },
  };
}

function errorMessageFor(code: string | undefined): string {
  switch (code) {
    case "reconnect_required":
      return "Your AniList connection needs to be renewed.";
    case "rate_limited":
      return "AniList is rate-limiting requests right now. Try again shortly.";
    case "not_connected":
      return "AniList isn't connected.";
    default:
      return "AniList could not be reached. Nothing was changed.";
  }
}

function PreviewList({
  preview,
  selections,
  onChoice,
}: {
  preview: WritebackPreview;
  selections: Record<string, ItemSelection>;
  onChoice: (itemId: string, field: FieldKey, choice: Choice) => void;
}) {
  const changed = preview.items.filter((entry) => !isFullyMatching(entry.reconciliation));
  const matching = preview.items.filter((entry) => isFullyMatching(entry.reconciliation));
  const [showMatching, setShowMatching] = useState(false);

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {preview.items.length} item{preview.items.length === 1 ? "" : "s"} checked · {matching.length} already match · {changed.length} need review
      </p>
      {!preview.writesAllowed && (
        <p className="rounded-md border border-border bg-surface-hover px-3 py-2 text-xs text-muted-foreground">
          Markly can’t update AniList yet — turn on “Allow Markly to update AniList” below to send changes there. You can still bring AniList’s changes into Markly.
        </p>
      )}

      <ul className="space-y-3">
        {changed.map((entry) => (
          <ItemCard key={entry.reconciliation.itemId} entry={entry} selection={selections[entry.reconciliation.itemId]} onChoice={onChoice} writesAllowed={preview.writesAllowed} />
        ))}
      </ul>

      {matching.length > 0 && (
        <div>
          <button type="button" onClick={() => setShowMatching((v) => !v)} className="text-xs font-medium text-accent hover:underline">
            {showMatching ? "Hide" : "Show"} {matching.length} already-matching item{matching.length === 1 ? "" : "s"}
          </button>
          {showMatching && (
            <ul className="mt-2 space-y-1">
              {matching.map((entry) => (
                <li key={entry.reconciliation.itemId} className="text-sm text-muted-foreground">
                  {entry.reconciliation.title}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function isFullyMatching(item: ItemReconciliation): boolean {
  return item.fields.progress.state === "same" && item.fields.status.state === "same" && item.fields.rating.state === "same";
}

function ItemCard({
  entry,
  selection,
  onChoice,
  writesAllowed,
}: {
  entry: WritebackPreviewItem;
  selection: ItemSelection;
  onChoice: (itemId: string, field: FieldKey, choice: Choice) => void;
  writesAllowed: boolean;
}) {
  const item = entry.reconciliation;
  return (
    <li className="rounded-md border border-border p-3">
      <p className="text-sm font-medium text-foreground">{item.title}</p>
      {!item.remoteExists && <p className="mt-0.5 text-xs font-medium text-accent">Not on your AniList list — selected changes will create a new entry.</p>}

      <div className="mt-2 space-y-3">
        {item.fields.progress.state !== "not_applicable" && (
          <FieldRow
            itemId={item.itemId}
            fieldKey="progress"
            label="Progress"
            field={item.fields.progress}
            localText={progressLabel(item, item.fields.progress.local)}
            remoteText={progressLabel(item, item.fields.progress.remote)}
            choice={selection.progress}
            onChoice={(choice) => onChoice(item.itemId, "progress", choice)}
            writesAllowed={writesAllowed}
          />
        )}
        <FieldRow
          itemId={item.itemId}
          fieldKey="status"
          label="Status"
          field={item.fields.status}
          localText={statusLabel(item.fields.status.local)}
          remoteText={statusLabel(item.fields.status.remote)}
          choice={selection.status}
          onChoice={(choice) => onChoice(item.itemId, "status", choice)}
          writesAllowed={writesAllowed}
        />
        <FieldRow
          itemId={item.itemId}
          fieldKey="rating"
          label="Rating"
          field={item.fields.rating}
          localText={ratingLabel(item.fields.rating.local)}
          remoteText={ratingLabel(item.fields.rating.remote)}
          choice={selection.rating}
          onChoice={(choice) => onChoice(item.itemId, "rating", choice)}
          writesAllowed={writesAllowed}
        />
      </div>
    </li>
  );
}

function FieldRow<T>({
  itemId,
  fieldKey,
  label,
  field,
  localText,
  remoteText,
  choice,
  onChoice,
  writesAllowed,
}: {
  itemId: string;
  fieldKey: FieldKey;
  label: string;
  field: FieldReconciliation<T>;
  localText: string;
  remoteText: string;
  choice: Choice;
  onChoice: (choice: Choice) => void;
  writesAllowed: boolean;
}) {
  if (field.state === "same") return null;

  if (field.state === "unsupported" || !fieldHasChoices(field)) {
    return (
      <div className="text-xs text-muted-foreground">
        <span className="font-medium uppercase tracking-wide text-muted-foreground/70">{label}: </span>
        {field.reason ? UNSUPPORTED_COPY[field.reason] : "Can’t be synced automatically."}
      </div>
    );
  }

  const groupName = buildReconciliationRadioGroupName(itemId, fieldKey);
  const canToAnilist = field.allowedDirections.includes("to_anilist") && writesAllowed;

  return (
    <fieldset className="text-sm">
      <legend className="text-xs font-medium uppercase tracking-wide text-muted-foreground/70">{label}</legend>
      <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-sm text-muted-foreground sm:grid-cols-[1fr_1fr]">
        <p>Markly&nbsp;&nbsp;{localText}</p>
        <p>AniList&nbsp;&nbsp;{remoteText}</p>
      </div>
      <div className="mt-1.5 flex flex-col gap-1 sm:flex-row sm:gap-4">
        <label htmlFor={`${groupName}-none`} className="flex items-center gap-1.5 text-sm text-foreground">
          <input id={`${groupName}-none`} type="radio" name={groupName} checked={choice === "none"} onChange={() => onChoice("none")} />
          No change
        </label>
        {field.allowedDirections.includes("to_markly") && (
          <label htmlFor={`${groupName}-to_markly`} className="flex items-center gap-1.5 text-sm text-foreground">
            <input id={`${groupName}-to_markly`} type="radio" name={groupName} checked={choice === "to_markly"} onChange={() => onChoice("to_markly")} />
            Use AniList
          </label>
        )}
        {field.allowedDirections.includes("to_anilist") && (
          <label htmlFor={`${groupName}-to_anilist`} className={`flex items-center gap-1.5 text-sm ${canToAnilist ? "text-foreground" : "text-muted-foreground/50"}`}>
            <input id={`${groupName}-to_anilist`} type="radio" name={groupName} checked={choice === "to_anilist"} disabled={!canToAnilist} onChange={() => onChoice("to_anilist")} />
            Use Markly
          </label>
        )}
      </div>
    </fieldset>
  );
}

function ResultsSummary({
  results,
  changedWhileReviewing,
  needsAttention,
  onRefresh,
}: {
  results: ApplyItemResult[];
  changedWhileReviewing: number;
  needsAttention: number;
  onRefresh: () => void;
}) {
  const applied = results.filter((r) => r.status === "applied").length;
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-foreground">AniList sync complete</p>
      <ul className="space-y-1 text-sm text-muted-foreground">
        <li>{applied} change{applied === 1 ? "" : "s"} applied</li>
        {changedWhileReviewing > 0 && <li>{changedWhileReviewing} item{changedWhileReviewing === 1 ? "" : "s"} changed while you were reviewing — skipped safely</li>}
        {needsAttention > 0 && <li>{needsAttention} item{needsAttention === 1 ? "" : "s"} needs attention</li>}
      </ul>
      {(changedWhileReviewing > 0 || needsAttention > 0) && (
        <button type="button" onClick={onRefresh} className="text-xs font-medium text-accent hover:underline">
          Review remaining
        </button>
      )}
    </div>
  );
}
