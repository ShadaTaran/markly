"use client";

import { useEffect, useState } from "react";
import type { MediaItem, MetadataProvider } from "@/types/library-item";
import { ITEM_TYPE_LABELS } from "@/types/library-item";
import { getMetadataProvider } from "@/lib/metadata/registry";
import type { MetadataDetails } from "@/lib/metadata/types";
import { ItemTypeIcon } from "@/components/ItemTypeIcon";

const MIN_QUERY_LENGTH = 2;
const DEBOUNCE_MS = 400;

const PROVIDER_ATTRIBUTION: Record<MetadataProvider, string> = {
  anilist: "Data from AniList",
  "open-library": "Data from Open Library",
  tmdb: "Data from TMDB",
  rawg: "Data from RAWG",
};

type SearchState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; results: MetadataDetails[] }
  | { status: "empty" }
  | { status: "error" };

interface MetadataSearchPanelProps {
  itemType: MediaItem["type"];
  onSelect: (details: MetadataDetails) => void;
  onManualEntry: () => void;
}

export function MetadataSearchPanel({ itemType, onSelect, onManualEntry }: MetadataSearchPanelProps) {
  const [query, setQuery] = useState("");
  const [state, setState] = useState<SearchState>({ status: "idle" });
  const [selectingId, setSelectingId] = useState<string | null>(null);
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

      <div aria-live="polite" className="min-h-16">
        {displayState.status === "idle" && (
          <p className="text-sm text-muted-foreground">Search the catalog, or enter details yourself.</p>
        )}
        {displayState.status === "loading" && <p className="text-sm text-muted-foreground">Searching…</p>}
        {displayState.status === "empty" && (
          <p className="text-sm text-muted-foreground">{`No results found for "${trimmedQuery}".`}</p>
        )}
        {displayState.status === "error" && (
          <p className="text-sm text-muted-foreground">
            Unable to search right now. You can still enter this item manually.
          </p>
        )}
        {displayState.status === "success" && (
          <ul className="max-h-72 space-y-1 overflow-y-auto">
            {displayState.results.map((result) => (
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

      <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
        <p className="text-xs text-muted-foreground">{PROVIDER_ATTRIBUTION[provider.id]}</p>
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
