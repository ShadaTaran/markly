"use client";

import { useEffect, useState } from "react";
import type { MediaItem, MetadataProvider } from "@/types/library-item";
import { ITEM_TYPE_LABELS } from "@/types/library-item";
import { getMetadataProvider } from "@/lib/metadata/registry";
import { partitionByRelevance } from "@/lib/metadata/relevance";
import type { MetadataDetails } from "@/lib/metadata/types";
import { ItemTypeIcon } from "@/components/ItemTypeIcon";

const MIN_QUERY_LENGTH = 2;
const DEBOUNCE_MS = 400;

const PROVIDER_SOURCE_NAME: Record<MetadataProvider, string> = {
  anilist: "AniList",
  "open-library": "Open Library",
  tmdb: "TMDB",
  rawg: "RAWG",
};

type SearchState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; results: MetadataDetails[] }
  | { status: "empty" }
  | { status: "error" };

/**
 * Offers the work a browser-extension detection already identified — a
 * persistent, always-visible section, never conditioned on what catalog
 * search happens to return (see README "Add or Link"). The detected
 * source is authoritative for title/progress/site; catalog search is
 * optional *enrichment* on top of it, never a gate in front of it — a
 * page of irrelevant Open Library fuzzy matches must never hide this, and
 * neither can zero results or a provider outage. The user is never asked
 * to retype a title Markly already has.
 */
export interface DetectedFallback {
  title: string;
  sourceLabel: string;
  progressLabel?: string;
  /** Safe cover art from the detection (Stage 21 metadata enrichment) — shown only when actually present, never a placeholder. */
  coverUrl?: string;
  onAddAndTrack: () => void;
  onEditDetails: () => void;
  busy: boolean;
}

interface MetadataSearchPanelProps {
  itemType: MediaItem["type"];
  onSelect: (details: MetadataDetails) => void;
  onManualEntry: () => void;
  /** Pre-fills the search box (e.g. from a browser-extension-detected work title) — the search still runs through the normal debounce, it just starts already typed in. */
  initialQuery?: string;
  detectedFallback?: DetectedFallback;
}

export function MetadataSearchPanel({ itemType, onSelect, onManualEntry, initialQuery, detectedFallback }: MetadataSearchPanelProps) {
  const [query, setQuery] = useState(initialQuery ?? "");
  const [state, setState] = useState<SearchState>({ status: "idle" });
  const [selectingId, setSelectingId] = useState<string | null>(null);
  const [showUnrelated, setShowUnrelated] = useState(false);
  const provider = getMetadataProvider(itemType);
  const label = ITEM_TYPE_LABELS[itemType];

  // Below MIN_QUERY_LENGTH there's nothing to fetch, so the idle state is
  // derived at render time from `query` itself rather than stored — no
  // setState needed for that case, and no stale "success"/"error" flashes
  // while the box is empty.
  const trimmedQuery = query.trim();
  const displayState: SearchState = trimmedQuery.length < MIN_QUERY_LENGTH ? { status: "idle" } : state;

  useEffect(() => {
    if (trimmedQuery.length < MIN_QUERY_LENGTH) return;

    const controller = new AbortController();

    // The loading/success/empty/error transitions all happen inside this
    // callback (not synchronously in the effect body), and a newer query
    // (or unmount) cancels the in-flight request for the previous one, so
    // a slow "fri" response can never overwrite a faster "frieren" result.
    const timeout = setTimeout(() => {
      setState({ status: "loading" });
      setShowUnrelated(false);
      provider
        .search(trimmedQuery, controller.signal)
        .then((results) => {
          if (controller.signal.aborted) return;
          setState(results.length > 0 ? { status: "success", results } : { status: "empty" });
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          setState({ status: "error" });
        });
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [trimmedQuery, provider]);

  async function handleSelect(result: MetadataDetails) {
    if (!provider.fetchDetails) {
      onSelect(result);
      return;
    }

    setSelectingId(result.externalId);
    const controller = new AbortController();
    try {
      const details = await provider.fetchDetails(result, controller.signal);
      onSelect(details);
    } catch {
      onSelect(result);
    } finally {
      setSelectingId(null);
    }
  }

  // A provider like combinedNovelProvider can draw results from more than
  // one catalog in a single search — attribution reflects whichever
  // sources actually contributed to the results on screen, not just the
  // adapter's own top-level id (which, for a combined provider, is only a
  // fallback label for the idle/error states below).
  const attributionSources =
    displayState.status === "success"
      ? Array.from(new Set(displayState.results.map((result) => PROVIDER_SOURCE_NAME[result.provider])))
      : [PROVIDER_SOURCE_NAME[provider.id]];

  // Novel is the one type actually querying more than one catalog at once
  // (combined-novel.ts) — named explicitly here so the loading message can
  // say "Searching Open Library and AniList…" rather than naming only the
  // combined provider's arbitrary fallback id.
  const loadingSources: MetadataProvider[] = itemType === "novel" ? ["open-library", "anilist"] : [provider.id];

  // Deterministic relevance ranking (see lib/metadata/relevance.ts) — for
  // *display* only. A provider returning a fuzzy/unrelated result (Open
  // Library's free-text search in particular) must never be presented as
  // a likely match; it's set aside behind "Show more" instead of hidden
  // outright. This never affects Smart Auto-Link, which has its own,
  // separate, exact-match-only comparison.
  const relevancePartition =
    displayState.status === "success" ? partitionByRelevance(trimmedQuery, displayState.results, (r) => r.title) : null;

  return (
    <div className="space-y-4">
      <div>
        <label htmlFor="metadata-search" className="mb-1.5 block text-sm font-medium text-foreground">
          {`Search ${label}`}
        </label>
        <input
          id="metadata-search"
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={`Search for ${label.toLowerCase()}…`}
          autoFocus
          className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/25"
        />
      </div>

      {/*
       * Detected-from-your-reading is persistent and independent of
       * catalog search state — it must remain available whether the
       * catalog returns zero, one, or ten results, fuzzy/irrelevant
       * matches, or errors out entirely (see DetectedFallback's doc
       * comment). Rendered unconditionally on `detectedFallback` alone,
       * never on `displayState`.
       */}
      {detectedFallback && (
        <div className="rounded-md border border-border bg-surface p-3">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">Detected from your reading</p>
          <div className="mt-1.5 flex items-start gap-2.5">
            {detectedFallback.coverUrl && (
              // eslint-disable-next-line @next/next/no-img-element -- plain <img> matches ItemCover's convention; this is an arbitrary external URL, not a local/optimizable asset.
              <img
                src={detectedFallback.coverUrl}
                alt=""
                className="h-14 w-10 shrink-0 rounded object-cover"
              />
            )}
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">{detectedFallback.title}</p>
              <p className="text-xs text-muted-foreground">
                {detectedFallback.sourceLabel}
                {detectedFallback.progressLabel ? ` · ${detectedFallback.progressLabel}` : ""}
              </p>
            </div>
          </div>
          <div className="mt-2.5 flex items-center gap-2">
            <button
              type="button"
              onClick={detectedFallback.onAddAndTrack}
              disabled={detectedFallback.busy}
              className="rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background transition-colors hover:bg-foreground/85 disabled:opacity-60"
            >
              {detectedFallback.busy ? "Adding…" : "Add & Track"}
            </button>
            <button
              type="button"
              onClick={detectedFallback.onEditDetails}
              disabled={detectedFallback.busy}
              className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-hover disabled:opacity-60"
            >
              Edit Details
            </button>
          </div>
        </div>
      )}

      <div>
        {detectedFallback && (
          <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">Catalog matches</p>
        )}
        <div aria-live="polite" className="min-h-16">
          {displayState.status === "idle" && (
            <p className="text-sm text-muted-foreground">
              {detectedFallback ? "Search for richer metadata, or use the detected work above." : "Search the catalog, or enter details yourself."}
            </p>
          )}
          {displayState.status === "loading" && (
            <p className="text-sm text-muted-foreground">{`Searching ${loadingSources.map((id) => PROVIDER_SOURCE_NAME[id]).join(" and ")}…`}</p>
          )}
          {displayState.status === "empty" && (
            <p className="text-sm text-muted-foreground">{`No results found for "${trimmedQuery}".`}</p>
          )}
          {displayState.status === "error" && (
            <p className="text-sm text-muted-foreground">
              {detectedFallback
                ? "Catalog search unavailable — this doesn't affect the detected work above."
                : "Unable to search right now. You can still enter this item manually."}
            </p>
          )}
          {relevancePartition && relevancePartition.relevant.length === 0 && relevancePartition.unrelated.length > 0 && (
            <p className="text-sm text-muted-foreground">{`No closely matching results for "${trimmedQuery}".`}</p>
          )}
          {relevancePartition && relevancePartition.relevant.length > 0 && (
            <ul className="max-h-72 space-y-1 overflow-y-auto">
              {relevancePartition.relevant.map((result) => (
                <li key={result.externalId}>
                  <ResultRow
                    result={result}
                    itemType={itemType}
                    onSelect={() => handleSelect(result)}
                    busy={selectingId === result.externalId}
                    disabled={selectingId !== null}
                  />
                </li>
              ))}
            </ul>
          )}
          {relevancePartition && relevancePartition.unrelated.length > 0 && (
            <div className="mt-1.5">
              {!showUnrelated ? (
                <button
                  type="button"
                  onClick={() => setShowUnrelated(true)}
                  className="text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                >
                  {`Show ${relevancePartition.unrelated.length} more result${relevancePartition.unrelated.length === 1 ? "" : "s"}`}
                </button>
              ) : (
                <ul className="max-h-72 space-y-1 overflow-y-auto">
                  {relevancePartition.unrelated.map((result) => (
                    <li key={result.externalId}>
                      <ResultRow
                        result={result}
                        itemType={itemType}
                        onSelect={() => handleSelect(result)}
                        busy={selectingId === result.externalId}
                        disabled={selectingId !== null}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
        <p className="text-xs text-muted-foreground">{`Data from ${attributionSources.join(" and ")}`}</p>
        <button
          type="button"
          onClick={onManualEntry}
          className="shrink-0 rounded-md border border-border px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          Enter manually
        </button>
      </div>
    </div>
  );
}

interface ResultRowProps {
  result: MetadataDetails;
  itemType: MediaItem["type"];
  onSelect: () => void;
  busy: boolean;
  disabled: boolean;
}

function ResultRow({ result, itemType, onSelect, busy, disabled }: ResultRowProps) {
  const [imageFailed, setImageFailed] = useState(false);
  const showImage = Boolean(result.imageUrl) && !imageFailed;

  const metaParts: string[] = [];
  if (result.year) metaParts.push(String(result.year));
  metaParts.push(ITEM_TYPE_LABELS[itemType]);
  // Novel is the one type backed by more than one catalog (see
  // combined-novel.ts) — showing which one this particular result came
  // from helps distinguish "Open Library" (traditionally published) from
  // "AniList" (light novel) results sitting side by side.
  if (itemType === "novel") metaParts.push(PROVIDER_SOURCE_NAME[result.provider]);

  const progressPart =
    itemType === "manga" && result.totalChapters !== undefined
      ? `${result.totalChapters} chapters`
      : (itemType === "anime" || itemType === "series") && result.totalEpisodes !== undefined
        ? `${result.totalEpisodes} episodes`
        : undefined;

  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      aria-busy={busy}
      className="flex w-full items-center gap-3 rounded-md border border-transparent p-2 text-left transition-colors hover:border-border hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50"
    >
      <span className="flex h-12 w-9 shrink-0 items-center justify-center overflow-hidden rounded border border-border bg-background">
        {showImage ? (
          // eslint-disable-next-line @next/next/no-img-element -- external catalog art from arbitrary hosts; next/image's optimizer isn't a good fit here.
          <img
            src={result.imageUrl}
            alt={`${result.title} cover`}
            className="h-full w-full object-cover"
            onError={() => setImageFailed(true)}
          />
        ) : (
          <ItemTypeIcon type={itemType} width={16} height={16} className="text-muted-foreground" aria-hidden="true" />
        )}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-foreground">{result.title}</span>
        <span className="block truncate text-xs text-muted-foreground">{metaParts.join(" • ")}</span>
        {progressPart && <span className="block truncate text-xs text-muted-foreground">{progressPart}</span>}
      </span>
      {busy && <span className="ml-auto shrink-0 text-xs text-muted-foreground">Loading…</span>}
    </button>
  );
}
