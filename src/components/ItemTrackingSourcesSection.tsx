"use client";

import { useEffect, useState } from "react";
import type { TrackingSourceSummary } from "@/lib/extension/types";
import { formatRelativeTime } from "@/lib/activity-format";
import { getSafeOpenSourceUrl, getSourceDisplayName, getSourceHostname, formatSourceProgress } from "@/lib/extension/source-display";
import { ExternalLinkIcon } from "@/components/icons";
import { AddSourceDialog, type AddSourceOutcome } from "@/components/AddSourceDialog";
import { Button } from "@/components/Button";

interface ItemTrackingSourcesSectionProps {
  itemId: string;
  /** Cloud-only concept — tracking_sources has no local/signed-out equivalent (it's entirely extension/Supabase-driven), so this section renders nothing at all when signed out, same as the Auto Tracking settings page. */
  userId: string | null;
}

/**
 * "Where is Markly tracking this item from?" — answerable without opening
 * Settings (see README "Cross-Source Work Identity"). Fetches only this
 * item's sources (?libraryItemId=) rather than every source the user has,
 * and only when signed in. Stage 40 — unlike its Stage 26 predecessor, this
 * now ALSO renders a restrained empty state + "Add source" action when
 * there are zero sources yet, instead of rendering nothing.
 */
export function ItemTrackingSourcesSection({ itemId, userId }: ItemTrackingSourcesSectionProps) {
  const [sources, setSources] = useState<TrackingSourceSummary[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [addOpen, setAddOpen] = useState(false);
  const [addNotice, setAddNotice] = useState<string | undefined>();

  function refetch() {
    if (!userId) return;
    fetch(`/api/tracking-sources?libraryItemId=${encodeURIComponent(itemId)}`)
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("failed"))))
      .then((data: { sources: TrackingSourceSummary[] }) => setSources(data.sources))
      .catch(() => setSources((current) => current ?? []));
  }

  useEffect(() => {
    // No setState here for the signed-out case: the render below already
    // returns null whenever `!userId`, regardless of whatever `sources`
    // currently holds, so there's nothing to reset — this keeps the
    // effect a pure "fetch and subscribe" body with no synchronous
    // setState call in it.
    if (!userId) return;
    let cancelled = false;
    fetch(`/api/tracking-sources?libraryItemId=${encodeURIComponent(itemId)}`)
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("failed"))))
      .then((data: { sources: TrackingSourceSummary[] }) => {
        if (!cancelled) setSources(data.sources);
      })
      .catch(() => {
        if (!cancelled) setSources([]);
      });
    return () => {
      cancelled = true;
    };
  }, [itemId, userId]);

  async function toggleAutoTrack(sourceId: string, enabled: boolean) {
    setBusy(`toggle-${sourceId}`);
    setError(undefined);
    setSources((current) => current?.map((source) => (source.id === sourceId ? { ...source, autoTrackEnabled: enabled } : source)) ?? current);
    try {
      const response = await fetch("/api/tracking-sources/toggle-auto-track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceId, enabled }),
      });
      if (!response.ok) throw new Error("failed");
    } catch {
      setSources((current) => current?.map((source) => (source.id === sourceId ? { ...source, autoTrackEnabled: !enabled } : source)) ?? current);
      setError("Couldn't update that setting. Try again.");
    } finally {
      setBusy(null);
    }
  }

  async function unlink(sourceId: string) {
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
      setSources((current) => current?.filter((source) => source.id !== sourceId) ?? current);
    } catch {
      setError("Couldn't unlink that source. Try again.");
    } finally {
      setBusy(null);
    }
  }

  function handleAddSourceOutcome(outcome: AddSourceOutcome) {
    setAddNotice(undefined);
    if (outcome.status === "created" || outcome.status === "linked") {
      refetch();
      return;
    }
    if (outcome.status === "already-linked") {
      setAddNotice("This source is already linked.");
      return;
    }
    // conflict — already linked to a DIFFERENT item; never silently moved (Stage 40 §10).
    setAddNotice("This source is already linked to a different library item.");
  }

  if (!userId || !sources) return null;

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
          {sources.map((source) => {
            const hostname = getSourceHostname(source.sourceUrl);
            const openUrl = getSafeOpenSourceUrl(source);
            return (
              <li key={source.id} className="rounded-md border border-border p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">{getSourceDisplayName(source.adapterId, source.sourceUrl, source.sourceTitle)}</p>
                    {hostname && <p className="truncate text-xs text-muted-foreground">{hostname}</p>}
                  </div>
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
          })}
        </ul>
      )}

      <AddSourceDialog isOpen={addOpen} libraryItemId={itemId} onClose={() => setAddOpen(false)} onLinked={handleAddSourceOutcome} />
    </section>
  );
}
