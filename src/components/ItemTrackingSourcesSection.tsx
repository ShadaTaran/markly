"use client";

import { useState } from "react";
import type { TrackingSourceSummary } from "@/lib/extension/types";
import { formatRelativeTime } from "@/lib/activity-format";
import { getSafeOpenSourceUrl, getSourceDisplayName, getSourceHostname, formatSourceProgress } from "@/lib/extension/source-display";
import { selectRecentlyUsedSource } from "@/lib/resume";
import { ExternalLinkIcon } from "@/components/icons";
import { AddSourceDialog, type AddSourceOutcome } from "@/components/AddSourceDialog";
import { Button } from "@/components/Button";

interface ItemTrackingSourcesSectionProps {
  itemId: string;
  /** Cloud-only concept — tracking_sources has no local/signed-out equivalent (it's entirely extension/Supabase-driven), so this section renders nothing at all when signed out, same as the Auto Tracking settings page. */
  userId: string | null;
  /**
   * Stage 41.2 — the item's linked sources, now OWNED and fetched by
   * ItemDetailView (the same data its own primary Continue/Resume action
   * already needs), not by this section itself. `null` means "still
   * loading" (same meaning the section's own removed fetch used to give
   * it). This section is a controlled component: it renders this list and
   * reports every change back through `onSourcesChange` rather than
   * keeping a second, independently-fetched copy — the exact duplicate-
   * fetch/stale-primary-button split a live production test caught (see
   * ItemDetailView's own doc comment on `trackingSources`).
   */
  sources: TrackingSourceSummary[] | null;
  /**
   * Called to update the parent's authoritative source state — either with
   * a new list (any successful add/link/unlink/toggle) or with `null` to
   * mark it UNKNOWN. Stage 41.3 — a live-scenario audit found that once a
   * server mutation has succeeded, the array this component held a moment
   * ago is no longer guaranteed correct (e.g. Add just added a second
   * source server-side) — so the one genuinely-necessary follow-up GET
   * (see handleAddSourceOutcome) invalidates the parent to `null` FIRST,
   * before it even starts, rather than only updating on success. If that
   * GET fails, the parent is left at `null` rather than quietly continuing
   * to treat the pre-mutation array as current — the same `null` already
   * used for "still loading," so ItemDetailView's existing `trackingSources
   * ?? []` fallback naturally stops offering a (possibly stale) direct/
   * choose_source Continue target without any change to resolveResumeTarget
   * itself.
   */
  onSourcesChange: (sources: TrackingSourceSummary[] | null) => void;
}

/**
 * "Where is Markly tracking this item from?" — answerable without opening
 * Settings (see README "Cross-Source Work Identity"). Stage 40 — unlike its
 * Stage 26 predecessor, this now ALSO renders a restrained empty state +
 * "Add source" action when there are zero sources yet, instead of
 * rendering nothing.
 */
export function ItemTrackingSourcesSection({ itemId, userId, sources, onSourcesChange }: ItemTrackingSourcesSectionProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [addOpen, setAddOpen] = useState(false);
  const [addNotice, setAddNotice] = useState<string | undefined>();

  async function toggleAutoTrack(sourceId: string, enabled: boolean) {
    if (!sources) return;
    const previous = sources;
    setBusy(`toggle-${sourceId}`);
    setError(undefined);
    onSourcesChange(previous.map((source) => (source.id === sourceId ? { ...source, autoTrackEnabled: enabled } : source)));
    try {
      const response = await fetch("/api/tracking-sources/toggle-auto-track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceId, enabled }),
      });
      if (!response.ok) throw new Error("failed");
    } catch {
      onSourcesChange(previous);
      setError("Couldn't update that setting. Try again.");
    } finally {
      setBusy(null);
    }
  }

  async function unlink(sourceId: string) {
    if (!sources) return;
    const previous = sources;
    setBusy(`unlink-${sourceId}`);
    setError(undefined);
    try {
      const response = await fetch("/api/tracking-sources/unlink", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceId }),
      });
      if (!response.ok) throw new Error("failed");
      // Unlinking removes this source from THIS item's list entirely — it
      // no longer belongs here (see README "Cross-Source Work Identity";
      // it stays visible, unlinked, in Settings > Auto Tracking instead).
      // Reported through onSourcesChange so ItemDetailView's own primary
      // Continue action recomputes immediately, in this same render pass —
      // no reload, no stale chooser/direct target left showing.
      onSourcesChange(previous.filter((source) => source.id !== sourceId));
    } catch {
      setError("Couldn't unlink that source. Try again.");
    } finally {
      setBusy(null);
    }
  }

  function handleAddSourceOutcome(outcome: AddSourceOutcome) {
    setAddNotice(undefined);
    if (outcome.status === "created" || outcome.status === "linked") {
      // Stage 41.3 (CRITICAL) — the server mutation has ALREADY succeeded
      // by this point (AddSourceDialog only calls onLinked on a 2xx
      // response), so the parent's pre-mutation array is immediately
      // stale/unverified — invalidate it to `null` before the reconciling
      // GET even starts, not only if that GET fails. Otherwise a failed
      // GET would leave the parent quietly treating the OLD array as
      // still authoritative (e.g. still showing a direct Continue target
      // to a single old source, when the server may now have two).
      onSourcesChange(null);
      setError(undefined);
      // AddSourceOutcome only carries {status, sourceId} — not the full
      // TrackingSourceSummary shape (adapterId, lastSeenAt, etc.) — so a
      // fresh GET is the one genuinely necessary network round-trip here,
      // per Stage 41.2's "a single deliberate refresh after a mutation is
      // acceptable" allowance. Its result is handed to the PARENT via
      // onSourcesChange rather than kept in a local state copy, so this is
      // still a single shared source of truth, not a second one.
      if (!userId) return;
      fetch(`/api/tracking-sources?libraryItemId=${encodeURIComponent(itemId)}`)
        .then((response) => (response.ok ? response.json() : Promise.reject(new Error("failed"))))
        .then((data: { sources: TrackingSourceSummary[] }) => onSourcesChange(data.sources))
        .catch(() => {
          // Leave the parent at `null` (already invalidated above) rather
          // than reinstating the old array — the source list genuinely is
          // unknown until the user reloads/retries. No automatic rollback
          // of the successful server mutation, no forced page reload.
          setError("Source added, but the source list couldn't refresh. Reload to see the latest sources.");
        });
      return;
    }
    if (outcome.status === "already-linked") {
      setAddNotice("This source is already linked.");
      return;
    }
    // conflict — already linked to a DIFFERENT item; never silently moved (Stage 40 §10).
    setAddNotice("This source is already linked to a different library item.");
  }

  // Stage 41.3 — deliberately no longer `!userId || !sources`: a `null`
  // source state can now mean "genuinely unknown after a failed post-
  // mutation refresh," not only "still loading," and the error message
  // explaining that must still render — returning null here entirely
  // would hide the very notice the user needs to see. Signed-out is
  // still the one true "render nothing" case.
  if (!userId) return null;

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">Sources</h2>
        {sources && sources.length > 0 && (
          <button type="button" onClick={() => setAddOpen(true)} className="text-xs font-medium text-accent hover:underline">
            Add source
          </button>
        )}
      </div>

      {error && <p className="mb-2 text-xs text-danger">{error}</p>}
      {addNotice && <p className="mb-2 text-xs text-muted-foreground">{addNotice}</p>}

      {!sources && (
        <div className="rounded-md border border-dashed border-border p-3">
          <p className="text-sm text-muted-foreground">{error ? "Sources unavailable." : "Loading sources…"}</p>
        </div>
      )}

      {sources && sources.length === 0 && (
        <div className="rounded-md border border-dashed border-border p-3">
          <p className="text-sm text-muted-foreground">No sources linked yet.</p>
          <Button variant="secondary" className="mt-2" onClick={() => setAddOpen(true)}>
            Add source
          </Button>
        </div>
      )}

      {sources && sources.length > 0 && (
        <ul className="space-y-2">
          {(() => {
            // Stage 41.1 — deliberately NOT the same question Continue
            // asks. selectRecentlyUsedSource answers "do we have genuine
            // USAGE evidence for this source" (real detection recency),
            // which is stricter than "can Continue deterministically open
            // it" — a single manual source resolves as a direct Continue
            // target (nothing to disambiguate) but must never be labeled
            // "Most recently used", since its last_seen_at only proves it
            // was added/linked, not consumed. See lib/resume.ts's own doc
            // comment on selectRecentlyUsedSource for the full rationale.
            const recentlyUsedSourceId = selectRecentlyUsedSource(sources, itemId)?.id ?? null;
            return sources.map((source) => {
              const hostname = getSourceHostname(source.sourceUrl);
              const openUrl = getSafeOpenSourceUrl(source);
              const isRecentlyUsedSource = source.id === recentlyUsedSourceId;
              return (
                <li key={source.id} className="rounded-md border border-border p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground">{getSourceDisplayName(source.adapterId, source.sourceUrl, source.sourceTitle)}</p>
                      {hostname && <p className="truncate text-xs text-muted-foreground">{hostname}</p>}
                    </div>
                    {isRecentlyUsedSource && (
                      <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                        Most recently used
                      </span>
                    )}
                  </div>

                <p className="mt-1.5 text-xs text-muted-foreground">
                  {formatSourceProgress(source.lastDetectedProgress)} · Last seen {formatRelativeTime(source.lastSeenAt)}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">Auto Tracking: {source.autoTrackEnabled ? "On" : "Off"}</p>

                <div className="mt-2 flex flex-wrap items-center gap-3">
                  {openUrl && (
                    <a href={openUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-xs font-medium text-accent hover:underline">
                      <ExternalLinkIcon width={12} height={12} />
                      Open Source
                    </a>
                  )}
                  <button
                    type="button"
                    onClick={() => toggleAutoTrack(source.id, !source.autoTrackEnabled)}
                    disabled={busy !== null}
                    className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60"
                  >
                    {busy === `toggle-${source.id}` ? "Updating…" : source.autoTrackEnabled ? "Disable" : "Enable"}
                  </button>
                  <button
                    type="button"
                    onClick={() => unlink(source.id)}
                    disabled={busy !== null}
                    className="text-xs font-medium text-muted-foreground transition-colors hover:text-danger disabled:opacity-60"
                  >
                    {busy === `unlink-${source.id}` ? "Unlinking…" : "Unlink"}
                  </button>
                </div>
              </li>
            );
            });
          })()}
        </ul>
      )}

      <AddSourceDialog isOpen={addOpen} libraryItemId={itemId} onClose={() => setAddOpen(false)} onLinked={handleAddSourceOutcome} />
    </section>
  );
}
