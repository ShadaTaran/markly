"use client";

import { useEffect, useMemo, useState } from "react";
import type {
  LibraryItem,
  MediaItem,
  MediaItemInput,
  SupportedItemType,
  WebsiteItem,
  WebsiteItemInput,
} from "@/types/library-item";
import { Header } from "@/components/Header";
import { FilterTabs } from "@/components/FilterTabs";
import { LibraryItemGrid } from "@/components/LibraryItemGrid";
import { LibraryItemDialog, type DialogState } from "@/components/LibraryItemDialog";
import { DeleteLibraryItemDialog } from "@/components/DeleteLibraryItemDialog";
import { SortSelect } from "@/components/SortSelect";
import { XIcon } from "@/components/icons";
import { generateId } from "@/lib/utils";
import { ALL_FILTER, FAVORITES_FILTER } from "@/lib/constants";
import { loadLibraryItems, saveLibraryItems } from "@/lib/library-storage";
import {
  createMediaItem,
  filterLibraryItems,
  getCategories,
  getItemTypeOptions,
  getUniqueCategories,
  normalizeCategory,
  sortLibraryItems,
  updateMediaItem,
  type SortOption,
  type TypeFilterValue,
} from "@/lib/library-items";

interface LibraryDashboardProps {
  items: LibraryItem[];
}

export function LibraryDashboard({ items: initialItems }: LibraryDashboardProps) {
  const [items, setItems] = useState(initialItems);
  const [isHydrated, setIsHydrated] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeType, setActiveType] = useState<TypeFilterValue>(ALL_FILTER);
  const [selectedCategory, setSelectedCategory] = useState<string>(ALL_FILTER);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [sortOption, setSortOption] = useState<SortOption>("newest");
  const [dialogState, setDialogState] = useState<DialogState>(null);
  const [deleteTarget, setDeleteTarget] = useState<LibraryItem | null>(null);

  // Runs once on mount (client-only). localStorage isn't available during
  // SSR/static prerendering, so the initial render always uses the starter
  // data to keep server and client output identical (no hydration
  // mismatch); this effect then syncs in any real stored library (or a
  // migrated Markly V1 bookmark list) after mount. Either way, hydration is
  // marked complete so the save effect below is allowed to run.
  useEffect(() => {
    const stored = loadLibraryItems();
    if (stored) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time sync from an external store (localStorage) on mount; the value cannot be derived during render because it isn't available at SSR/prerender time.
      setItems(stored);
    }
    setIsHydrated(true);
  }, []);

  // Persist items after every change, but only once the initial
  // localStorage read above has completed. Without this guard, this effect
  // would fire on first mount with the starter data and overwrite any
  // already-stored (or just-migrated) items before they've been loaded.
  useEffect(() => {
    if (!isHydrated) return;
    saveLibraryItems(items);
  }, [items, isHydrated]);

  const typeOptions = useMemo(() => getItemTypeOptions(items), [items]);

  // Categories are scoped to the active type — Type is the outer, fixed
  // dimension; Category is the dynamic, arbitrary one beneath it.
  const itemsForType = useMemo(
    () => (activeType === ALL_FILTER ? items : items.filter((item) => item.type === activeType)),
    [items, activeType],
  );

  const uniqueCategories = useMemo(() => getUniqueCategories(itemsForType), [itemsForType]);

  // If the selected category no longer has any items in the current type
  // scope (e.g. its last item was edited/deleted, or the type filter
  // changed), fall back to "All" instead of leaving the user stuck on a
  // filter tab that vanished.
  const activeCategory =
    selectedCategory === ALL_FILTER ||
    selectedCategory === FAVORITES_FILTER ||
    uniqueCategories.includes(selectedCategory)
      ? selectedCategory
      : ALL_FILTER;

  const categories = useMemo(() => getCategories(itemsForType), [itemsForType]);

  const filteredItems = useMemo(
    () => filterLibraryItems(items, { searchQuery, activeType, activeCategory, activeTag }),
    [items, searchQuery, activeType, activeCategory, activeTag],
  );

  const visibleItems = useMemo(
    () => sortLibraryItems(filteredItems, sortOption),
    [filteredItems, sortOption],
  );

  function handleToggleFavorite(id: string) {
    setItems((current) =>
      current.map((item) =>
        item.id === id ? { ...item, favorite: !item.favorite } : item,
      ),
    );
  }

  function handleTagClick(tag: string) {
    setActiveTag((current) => (current?.toLowerCase() === tag.toLowerCase() ? null : tag));
  }

  function handleOpenAddDialog() {
    setDialogState({ step: "pickType" });
  }

  function handleSelectType(itemType: SupportedItemType) {
    setDialogState({ step: "form", mode: "add", itemType });
  }

  function handleBackToPicker() {
    setDialogState({ step: "pickType" });
  }

  function handleOpenEditDialog(item: WebsiteItem | MediaItem) {
    setDialogState({ step: "form", mode: "edit", itemType: item.type, item });
  }

  function handleCloseDialog() {
    setDialogState(null);
  }

  function handleSubmitWebsite(values: WebsiteItemInput) {
    if (dialogState?.step !== "form") return;

    const normalizedValues = {
      ...values,
      category: normalizeCategory(values.category, uniqueCategories),
    };

    if (dialogState.mode === "edit" && dialogState.item.type === "website") {
      const { id, favorite, createdAt } = dialogState.item;
      const updated: WebsiteItem = {
        id,
        type: "website",
        favorite,
        createdAt,
        updatedAt: new Date().toISOString(),
        ...normalizedValues,
      };
      setItems((current) => current.map((item) => (item.id === id ? updated : item)));
    } else {
      const newItem: WebsiteItem = {
        id: generateId(),
        type: "website",
        favorite: false,
        createdAt: new Date().toISOString(),
        ...normalizedValues,
      };
      setItems((current) => [newItem, ...current]);
    }
    setDialogState(null);
  }

  function handleSubmitMedia(values: MediaItemInput) {
    if (dialogState?.step !== "form" || dialogState.itemType === "website") return;

    const normalizedValues = {
      ...values,
      category: normalizeCategory(values.category, uniqueCategories),
    };

    if (dialogState.mode === "edit" && dialogState.item.type !== "website") {
      const updated = updateMediaItem(dialogState.item, normalizedValues);
      setItems((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    } else {
      const newItem = createMediaItem(
        dialogState.itemType,
        generateId(),
        new Date().toISOString(),
        normalizedValues,
      );
      setItems((current) => [newItem, ...current]);
    }
    setDialogState(null);
  }

  function handleDeleteRequest(item: LibraryItem) {
    setDeleteTarget(item);
  }

  function handleCancelDelete() {
    setDeleteTarget(null);
  }

  function handleConfirmDelete() {
    if (!deleteTarget) return;
    const idToDelete = deleteTarget.id;
    setItems((current) => current.filter((item) => item.id !== idToDelete));
    setDeleteTarget(null);
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Header
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
        onAddItem={handleOpenAddDialog}
      />

      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
        <div>
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
            Type
          </p>
          <FilterTabs
            options={typeOptions}
            activeId={activeType}
            // FilterTabs is a generic string-id tab list (shared with the
            // Category row below); typeOptions is built by getItemTypeOptions
            // from ALL_FILTER + SUPPORTED_ITEM_TYPES, so every id it can ever
            // pass back here is already a valid TypeFilterValue.
            onChange={(id) => setActiveType(id as TypeFilterValue)}
            ariaLabel="Filter library by type"
          />
        </div>

        <div className="mt-4">
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
            Category
          </p>
          <FilterTabs
            options={categories}
            activeId={activeCategory}
            onChange={setSelectedCategory}
            ariaLabel="Filter library by category"
          />
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          {activeTag && (
            <button
              type="button"
              onClick={() => setActiveTag(null)}
              className="flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:border-foreground/40"
            >
              Tag: {activeTag}
              <XIcon width={13} height={13} />
            </button>
          )}
          <div className="ml-auto">
            <SortSelect value={sortOption} onChange={setSortOption} />
          </div>
        </div>

        <div className="mt-4">
          <LibraryItemGrid
            items={visibleItems}
            totalItems={items.length}
            searchQuery={searchQuery}
            activeType={activeType}
            activeCategory={activeCategory}
            activeTag={activeTag}
            onToggleFavorite={handleToggleFavorite}
            onEdit={handleOpenEditDialog}
            onDeleteRequest={handleDeleteRequest}
            onClearSearch={() => setSearchQuery("")}
            onClearTag={() => setActiveTag(null)}
            onTagClick={handleTagClick}
          />
        </div>
      </main>

      <LibraryItemDialog
        state={dialogState}
        existingCategories={uniqueCategories}
        onSelectType={handleSelectType}
        onBackToPicker={handleBackToPicker}
        onClose={handleCloseDialog}
        onSubmitWebsite={handleSubmitWebsite}
        onSubmitMedia={handleSubmitMedia}
      />

      <DeleteLibraryItemDialog
        item={deleteTarget}
        onCancel={handleCancelDelete}
        onConfirm={handleConfirmDelete}
      />
    </div>
  );
}
