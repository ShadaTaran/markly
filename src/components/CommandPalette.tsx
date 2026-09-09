"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { MediaItemInput, SupportedItemType, WebsiteItemInput } from "@/types/library-item";
import type { MetadataDetails } from "@/lib/metadata/types";
import { useAuth } from "@/components/AuthProvider";
import { useActivity } from "@/hooks/useActivity";
import { useLibraryItems } from "@/hooks/useLibraryItems";
import { useCommandPaletteRecents, resolveRecentItems } from "@/hooks/useCommandPaletteRecents";
import {
  buildPaletteResults,
  buildSearchDocuments,
  describeLibraryResult,
  flattenPaletteResults,
  MAX_QUERY_LENGTH,
  type PaletteResult,
} from "@/lib/command-palette";
import { getUniqueCategories } from "@/lib/library-items";
import { getItemHref, isMediaItem } from "@/lib/item-detail";
import { getDomain } from "@/lib/website";
import { LibraryCoverThumb } from "@/components/LibraryCoverThumb";
import { WebsiteFaviconThumb } from "@/components/WebsiteFaviconThumb";
import { LibraryItemDialog, type DialogState } from "@/components/LibraryItemDialog";
import { IconButton } from "@/components/IconButton";
import { SearchIcon, XIcon } from "@/components/icons";
import { cn } from "@/lib/utils";

interface CommandPaletteProps {
  onClose: () => void;
}

/**
 * Stage 36 — the Command Palette's actual content. Only ever mounted
 * while the palette is open (see CommandPaletteProvider) — its
 * useLibraryItems/useActivity calls are otherwise exactly the per-mount
 * fetch every other page-level consumer already pays, applied to one more
 * consumer, not a new permanent cost on every page (see the Stage report
 * for the documented tradeoff: no shared cache exists in this codebase,
 * so opening the palette re-fetches independently of whatever page you're
 * on, same as navigating between any two existing pages already does).
 *
 * Search itself never mutates anything (§41) — the only exception is the
 * explicit "Add Item" command, which opens the exact same LibraryItemDialog
 * every other Add Item entry point uses and goes through the exact same
 * useLibraryItems mutations, so it behaves identically (including the
 * same real Activity event) to adding an item from Library or Dashboard.
 */
export function CommandPalette({ onClose }: CommandPaletteProps) {
  const router = useRouter();
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const activity = useActivity(userId);
  const library = useLibraryItems([], activity.logEvent, userId);
  const { recentIds, recordOpened } = useCommandPaletteRecents();

  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [addItemDialogState, setAddItemDialogState] = useState<DialogState>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const resultRefs = useRef<(HTMLElement | null)[]>([]);
  const listboxId = useId();

  const docs = useMemo(() => buildSearchDocuments(library.items), [library.items]);
  const recentItems = useMemo(() => resolveRecentItems(recentIds, library.items), [recentIds, library.items]);
  const groups = useMemo(() => buildPaletteResults({ query, docs, recentItems }), [query, docs, recentItems]);
  const flatResults = useMemo(() => flattenPaletteResults(groups), [groups]);
  // Maps each result to its position in the flat keyboard-navigation order
  // — object-identity keyed (flattenPaletteResults concatenates the same
  // group arrays rather than cloning, so this holds within one render).
  // Looked up per row instead of an incrementing counter mutated during
  // render, which the React Compiler correctly flags as unsafe.
  const resultIndexMap = useMemo(() => new Map(flatResults.map((result, index) => [result, index])), [flatResults]);
  const trimmedQuery = query.trim();
  const isSearching = trimmedQuery !== "";
  const hasAnyMatch = flatResults.length > 0;
  // §69 — "No results" still leaves Add Item reachable, regardless of
  // whether the query text happens to match the word "Add Item" itself.
  const effectiveResults: PaletteResult[] =
    hasAnyMatch || !isSearching ? flatResults : [{ kind: "action", id: "action.add-item", label: "Add Item" }];

  // §82 — query/result-set changes must never leave activeIndex pointing
  // past the end (or at a stale index that now means something else).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting the selection is a direct response to the query/result-set changing, not derived state computable during render (the new result set isn't known until this render already happened).
    setActiveIndex(0);
  }, [query, effectiveResults.length]);

  useEffect(() => {
    if (addItemDialogState === null) inputRef.current?.focus();
  }, [addItemDialogState]);

  useEffect(() => {
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, []);

  function activate(result: PaletteResult) {
    if (result.kind === "library") {
      recordOpened(result.item.id);
      router.push(getItemHref(result.item));
      onClose();
      return;
    }
    if (result.kind === "navigation") {
      router.push(result.href);
      onClose();
      return;
    }
    // Only "action.add-item" exists today (§42) — opens the canonical
    // dialog in place of the search view rather than closing the whole
    // palette, since the dialog needs the same useLibraryItems instance
    // this component already holds for its mutations.
    setAddItemDialogState({ step: "pickType" });
  }

  function handleContainerKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => (effectiveResults.length === 0 ? 0 : (current + 1) % effectiveResults.length));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => (effectiveResults.length === 0 ? 0 : (current - 1 + effectiveResults.length) % effectiveResults.length));
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(Math.max(0, effectiveResults.length - 1));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const result = effectiveResults[activeIndex];
      if (result) activate(result);
    }
  }

  useEffect(() => {
    resultRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const existingCategories = useMemo(() => getUniqueCategories(library.items), [library.items]);

  function handleCloseAddItemDialog() {
    setAddItemDialogState(null);
    onClose();
  }

  function handleSelectType(itemType: SupportedItemType) {
    if (itemType === "website") {
      setAddItemDialogState({ step: "form", mode: "add", itemType });
    } else {
      setAddItemDialogState({ step: "search", mode: "add", itemType });
    }
  }

  function handleSelectSearchResult(details: MetadataDetails) {
    if (addItemDialogState?.step !== "search") return;
    setAddItemDialogState({ step: "form", mode: "add", itemType: addItemDialogState.itemType, prefill: details });
  }

  function handleManualEntry() {
    if (addItemDialogState?.step !== "search") return;
    setAddItemDialogState({ step: "form", mode: "add", itemType: addItemDialogState.itemType });
  }

  function handleBackToPicker() {
    setAddItemDialogState({ step: "pickType" });
  }

  function handleBackToSearch() {
    if (addItemDialogState?.step !== "form" || addItemDialogState.mode !== "add" || addItemDialogState.itemType === "website") return;
    setAddItemDialogState({ step: "search", mode: "add", itemType: addItemDialogState.itemType });
  }

  function handleToggleFullForm() {
    if (addItemDialogState?.step !== "form") return;
    setAddItemDialogState({ ...addItemDialogState, showFullForm: true });
  }

  function handleSubmitWebsite(values: WebsiteItemInput) {
    library.addWebsite(values);
    setAddItemDialogState(null);
    onClose();
  }

  function handleSubmitMedia(values: MediaItemInput) {
    if (addItemDialogState?.step !== "form" || addItemDialogState.itemType === "website") return;
    library.addMedia(addItemDialogState.itemType, values);
    setAddItemDialogState(null);
    onClose();
  }

  if (addItemDialogState !== null) {
    return (
      <LibraryItemDialog
        state={addItemDialogState}
        existingCategories={existingCategories}
        onSelectType={handleSelectType}
        onSelectSearchResult={handleSelectSearchResult}
        onManualEntry={handleManualEntry}
        onBackToPicker={handleBackToPicker}
        onBackToSearch={handleBackToSearch}
        onToggleFullForm={handleToggleFullForm}
        onClose={handleCloseAddItemDialog}
        onSubmitWebsite={handleSubmitWebsite}
        onSubmitMedia={handleSubmitMedia}
      />
    );
  }

  const activeResultId = effectiveResults.length > 0 ? `${listboxId}-option-${activeIndex}` : undefined;
  const showLoading = Boolean(userId) && !library.isHydrated;
  const showLibraryError = Boolean(library.error) && !showLoading;

  function registerResultRef(index: number, el: HTMLElement | null) {
    resultRefs.current[index] = el;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[10vh] sm:pt-[15vh]" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleContainerKeyDown}
        className="flex w-full max-w-xl flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-lg sm:max-w-2xl"
      >
        <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
          <SearchIcon width={18} height={18} className="shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listboxId}
            aria-activedescendant={activeResultId}
            aria-autocomplete="list"
            aria-label="Search Markly"
            autoComplete="off"
            spellCheck={false}
            maxLength={MAX_QUERY_LENGTH}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search your library, jump to a page, or run a command…"
            className="w-full min-w-0 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
          <IconButton onClick={onClose} aria-label="Close command palette" className="-m-1 shrink-0" icon={<XIcon width={14} height={14} />} />
        </div>

        <p aria-live="polite" className="sr-only">
          {isSearching ? `${flatResults.length} result${flatResults.length === 1 ? "" : "s"}` : ""}
        </p>

        <div id={listboxId} role="listbox" aria-label="Search results" className="max-h-[60vh] overflow-y-auto p-2">
          {showLoading && <p className="px-3 py-2 text-sm text-muted-foreground">Loading your library…</p>}
          {showLibraryError && <p className="px-3 py-2 text-sm text-danger">Couldn&apos;t load your library — Library search is unavailable right now.</p>}

          {groups.recent.length > 0 && (
            <ResultGroup heading="Recent">
              {groups.recent.map((result) => (
                <LibraryResultRow
                  key={result.item.id}
                  result={result}
                  index={resultIndexMap.get(result) ?? 0}
                  activeIndex={activeIndex}
                  listboxId={listboxId}
                  registerRef={registerResultRef}
                  onHover={setActiveIndex}
                  onActivate={activate}
                />
              ))}
            </ResultGroup>
          )}

          {groups.library.length > 0 && (
            <ResultGroup heading="Library">
              {groups.library.map((result) => (
                <LibraryResultRow
                  key={result.item.id}
                  result={result}
                  index={resultIndexMap.get(result) ?? 0}
                  activeIndex={activeIndex}
                  listboxId={listboxId}
                  registerRef={registerResultRef}
                  onHover={setActiveIndex}
                  onActivate={activate}
                />
              ))}
            </ResultGroup>
          )}

          {(groups.actions.length > 0 || groups.navigation.length > 0) && (
            <ResultGroup heading="Quick Actions">
              {groups.actions.map((result) => (
                <CommandResultRow
                  key={result.id}
                  result={result}
                  index={resultIndexMap.get(result) ?? 0}
                  activeIndex={activeIndex}
                  listboxId={listboxId}
                  registerRef={registerResultRef}
                  onHover={setActiveIndex}
                  onActivate={activate}
                />
              ))}
              {groups.navigation.map((result) => (
                <CommandResultRow
                  key={result.id}
                  result={result}
                  index={resultIndexMap.get(result) ?? 0}
                  activeIndex={activeIndex}
                  listboxId={listboxId}
                  registerRef={registerResultRef}
                  onHover={setActiveIndex}
                  onActivate={activate}
                />
              ))}
            </ResultGroup>
          )}

          {isSearching && !hasAnyMatch && (
            <div className="px-3 py-6 text-center">
              <p className="text-sm text-muted-foreground">No results for &ldquo;{trimmedQuery}&rdquo;</p>
              <button
                ref={(el) => {
                  resultRefs.current[0] = el;
                }}
                id={`${listboxId}-option-0`}
                role="option"
                aria-selected={activeIndex === 0}
                onMouseEnter={() => setActiveIndex(0)}
                onClick={() => activate(effectiveResults[0])}
                className={cn(
                  "mt-3 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  activeIndex === 0 ? "bg-accent/10 text-accent" : "text-muted-foreground hover:text-foreground",
                )}
              >
                Add Item
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ResultGroup({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <div className="mb-1 last:mb-0">
      <p className="px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">{heading}</p>
      {children}
    </div>
  );
}

interface RowProps<T extends PaletteResult> {
  result: T;
  index: number;
  activeIndex: number;
  listboxId: string;
  registerRef: (index: number, el: HTMLElement | null) => void;
  onHover: (index: number) => void;
  onActivate: (result: PaletteResult) => void;
}

function LibraryResultRow({ result, index, activeIndex, listboxId, registerRef, onHover, onActivate }: RowProps<Extract<PaletteResult, { kind: "library" }>>) {
  const item = result.item;
  const isActive = index === activeIndex;
  const isWebsite = item.type === "website";
  const secondary = isWebsite ? getDomain(item.url) : describeLibraryResult(item);

  return (
    <button
      ref={(el) => registerRef(index, el)}
      id={`${listboxId}-option-${index}`}
      role="option"
      aria-selected={isActive}
      type="button"
      onMouseEnter={() => onHover(index)}
      onClick={() => onActivate(result)}
      className={cn(
        "flex w-full items-center gap-3 rounded-md px-3 py-2 text-left transition-colors",
        isActive ? "bg-accent/10" : "hover:bg-surface-hover",
      )}
    >
      {isWebsite ? (
        <WebsiteFaviconThumb domain={secondary} className="h-8 w-8" iconSize={16} />
      ) : (
        <LibraryCoverThumb imageUrl={isMediaItem(item) ? item.imageUrl : undefined} type={item.type} className="h-9 w-8" iconSize={16} />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{item.title}</p>
        <p className="truncate text-xs text-muted-foreground">{secondary}</p>
      </div>
    </button>
  );
}

function CommandResultRow({
  result,
  index,
  activeIndex,
  listboxId,
  registerRef,
  onHover,
  onActivate,
}: RowProps<Extract<PaletteResult, { kind: "navigation" | "action" }>>) {
  const isActive = index === activeIndex;

  return (
    <button
      ref={(el) => registerRef(index, el)}
      id={`${listboxId}-option-${index}`}
      role="option"
      aria-selected={isActive}
      type="button"
      onMouseEnter={() => onHover(index)}
      onClick={() => onActivate(result)}
      className={cn(
        "flex w-full items-center rounded-md px-3 py-2 text-left text-sm font-medium transition-colors",
        isActive ? "bg-accent/10 text-accent" : "text-foreground hover:bg-surface-hover",
      )}
    >
      {result.label}
    </button>
  );
}
