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
import type { Collection, CollectionInput } from "@/types/collection";
import { Header } from "@/components/Header";
import { FilterTabs } from "@/components/FilterTabs";
import { CollectionFilterBar } from "@/components/CollectionFilterBar";
import { CollectionHeader } from "@/components/CollectionHeader";
import { CollectionDialog } from "@/components/CollectionDialog";
import { DeleteCollectionDialog } from "@/components/DeleteCollectionDialog";
import { CollectionMembershipDialog } from "@/components/CollectionMembershipDialog";
import { LibraryItemGrid } from "@/components/LibraryItemGrid";
import { LibraryItemDialog, type DialogState } from "@/components/LibraryItemDialog";
import { DeleteLibraryItemDialog } from "@/components/DeleteLibraryItemDialog";
import { SortSelect } from "@/components/SortSelect";
import { XIcon } from "@/components/icons";
import { generateId } from "@/lib/utils";
import { ALL_FILTER, FAVORITES_FILTER } from "@/lib/constants";
import { loadLibraryItems, saveLibraryItems } from "@/lib/library-storage";
import { loadCollections, saveCollections } from "@/lib/collection-storage";
import { getCollectionOptions, getValidItemIds, type CollectionFilterValue } from "@/lib/collections";
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
import { getStatusOptions, type StatusFilterValue } from "@/lib/tracking";
import type { MetadataDetails } from "@/lib/metadata/types";

interface LibraryDashboardProps {
  items: LibraryItem[];
}

type CollectionDialogState = { mode: "create" } | { mode: "edit"; collection: Collection } | null;

export function LibraryDashboard({ items: initialItems }: LibraryDashboardProps) {
  const [items, setItems] = useState(initialItems);
  const [isHydrated, setIsHydrated] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeType, setActiveType] = useState<TypeFilterValue>(ALL_FILTER);
  const [activeStatus, setActiveStatus] = useState<StatusFilterValue>(ALL_FILTER);
  const [selectedCategory, setSelectedCategory] = useState<string>(ALL_FILTER);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [sortOption, setSortOption] = useState<SortOption>("newest");
  const [dialogState, setDialogState] = useState<DialogState>(null);
  const [deleteTarget, setDeleteTarget] = useState<LibraryItem | null>(null);

  const [collections, setCollections] = useState<Collection[]>([]);
  const [isCollectionsHydrated, setIsCollectionsHydrated] = useState(false);
  const [activeCollectionId, setActiveCollectionId] = useState<CollectionFilterValue>(ALL_FILTER);
  const [collectionDialogState, setCollectionDialogState] = useState<CollectionDialogState>(null);
  const [collectionDeleteTarget, setCollectionDeleteTarget] = useState<Collection | null>(null);
  const [membershipItem, setMembershipItem] = useState<LibraryItem | null>(null);

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

  // Collections are a separate storage domain from the library (markly.collections
  // vs markly.library) — a missing or corrupt collections key never touches
  // markly.library, and vice versa. Missing key or malformed JSON both mean
  // "no collections yet" (an empty list), never a reason to fabricate any.
  useEffect(() => {
    const stored = loadCollections();
    if (stored) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time sync from an external store (localStorage) on mount; the value cannot be derived during render because it isn't available at SSR/prerender time.
      setCollections(stored);
    }
    setIsCollectionsHydrated(true);
  }, []);

  useEffect(() => {
    if (!isCollectionsHydrated) return;
    saveCollections(collections);
  }, [collections, isCollectionsHydrated]);

  // Self-healing membership cleanup: whenever the actual set of library items
  // changes (most notably a deletion), strip any collection item id that no
  // longer refers to a real item. Runs after both stores have hydrated so it
  // sees the real loaded items rather than the pre-hydration starter data.
  // Bails out (returns the same array reference) when nothing needs fixing,
  // so this never loops or persists a no-op change.
  useEffect(() => {
    if (!isHydrated || !isCollectionsHydrated) return;

    // eslint-disable-next-line react-hooks/set-state-in-effect -- reactive cross-store consistency fix (collections referencing deleted items), not derivable at render time since it must persist the corrected value, not just filter it for display.
    setCollections((current) => {
      let changed = false;
      const cleaned = current.map((collection) => {
        const validIds = getValidItemIds(collection, items);
        if (validIds.length !== collection.itemIds.length) {
          changed = true;
          return { ...collection, itemIds: validIds };
        }
        return collection;
      });
      return changed ? cleaned : current;
    });
  }, [items, isHydrated, isCollectionsHydrated]);

  const collectionOptions = useMemo(() => getCollectionOptions(collections, items), [collections, items]);

  const activeCollection = useMemo(
    () =>
      activeCollectionId === ALL_FILTER
        ? undefined
        : collections.find((collection) => collection.id === activeCollectionId),
    [collections, activeCollectionId],
  );

  // undefined activeCollection with a non-ALL_FILTER id means the selected
  // collection was just deleted elsewhere — treat that like "All Items"
  // rather than showing a blank/broken view.
  const collectionItemIds = useMemo(
    () => (activeCollection ? new Set(getValidItemIds(activeCollection, items)) : undefined),
    [activeCollection, items],
  );

  // Collection is the outermost scope: Type/Status/Category counts and
  // options all drill down from whichever collection (or "All Items") is
  // currently selected, exactly as Status/Category already drill down from
  // Type.
  const itemsForCollection = useMemo(
    () => (collectionItemIds ? items.filter((item) => collectionItemIds.has(item.id)) : items),
    [items, collectionItemIds],
  );

  const typeOptions = useMemo(() => getItemTypeOptions(itemsForCollection), [itemsForCollection]);

  const itemsForType = useMemo(
    () =>
      activeType === ALL_FILTER
        ? itemsForCollection
        : itemsForCollection.filter((item) => item.type === activeType),
    [itemsForCollection, activeType],
  );

  const statusOptions = useMemo(() => getStatusOptions(itemsForType), [itemsForType]);

  const itemsForTypeAndStatus = useMemo(
    () =>
      activeStatus === ALL_FILTER
        ? itemsForType
        : itemsForType.filter((item) => "status" in item && item.status === activeStatus),
    [itemsForType, activeStatus],
  );

  const uniqueCategories = useMemo(
    () => getUniqueCategories(itemsForTypeAndStatus),
    [itemsForTypeAndStatus],
  );

  // If the selected category no longer has any items in the current
  // type/status scope (e.g. its last item was edited/deleted, or a filter
  // changed), fall back to "All" instead of leaving the user stuck on a
  // filter tab that vanished.
  const activeCategory =
    selectedCategory === ALL_FILTER ||
    selectedCategory === FAVORITES_FILTER ||
    uniqueCategories.includes(selectedCategory)
      ? selectedCategory
      : ALL_FILTER;

  const categories = useMemo(() => getCategories(itemsForTypeAndStatus), [itemsForTypeAndStatus]);

  const filteredItems = useMemo(
    () =>
      filterLibraryItems(items, {
        searchQuery,
        activeType,
        activeStatus,
        activeCategory,
        activeTag,
        collectionItemIds,
      }),
    [items, searchQuery, activeType, activeStatus, activeCategory, activeTag, collectionItemIds],
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

  function handleQuickIncrement(target: MediaItem) {
    setItems((current) =>
      current.map((item) => {
        if (item.id !== target.id) return item;

        if (item.type === "anime" || item.type === "series") {
          const next = (item.currentEpisode ?? 0) + 1;
          const currentEpisode = item.totalEpisodes !== undefined ? Math.min(next, item.totalEpisodes) : next;
          return { ...item, currentEpisode, updatedAt: new Date().toISOString() };
        }

        if (item.type === "manga") {
          const next = (item.currentChapter ?? 0) + 1;
          const currentChapter = item.totalChapters !== undefined ? Math.min(next, item.totalChapters) : next;
          return { ...item, currentChapter, updatedAt: new Date().toISOString() };
        }

        return item;
      }),
    );
  }

  function handleTagClick(tag: string) {
    setActiveTag((current) => (current?.toLowerCase() === tag.toLowerCase() ? null : tag));
  }

  function handleOpenAddDialog() {
    setDialogState({ step: "pickType" });
  }

  function handleSelectType(itemType: SupportedItemType) {
    // Website has no metadata search — it goes straight to the form, as
    // before. Every media type offers a catalog search step first.
    if (itemType === "website") {
      setDialogState({ step: "form", mode: "add", itemType });
    } else {
      setDialogState({ step: "search", mode: "add", itemType });
    }
  }

  function handleSelectSearchResult(details: MetadataDetails) {
    if (dialogState?.step !== "search") return;
    setDialogState({ step: "form", mode: "add", itemType: dialogState.itemType, prefill: details });
  }

  function handleManualEntry() {
    if (dialogState?.step !== "search") return;
    setDialogState({ step: "form", mode: "add", itemType: dialogState.itemType });
  }

  function handleBackToPicker() {
    setDialogState({ step: "pickType" });
  }

  function handleBackToSearch() {
    if (dialogState?.step !== "form" || dialogState.mode !== "add" || dialogState.itemType === "website") return;
    setDialogState({ step: "search", mode: "add", itemType: dialogState.itemType });
  }

  function handleOpenEditDialog(item: WebsiteItem | MediaItem) {
    setDialogState({ step: "form", mode: "edit", itemType: item.type, item });
  }

  function handleToggleFullForm() {
    if (dialogState?.step !== "form") return;
    setDialogState({ ...dialogState, showFullForm: true });
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
    // Removing the item from `items` alone is enough — the stale-membership
    // cleanup effect above reacts to that change and strips the id from
    // every collection on its own, so deletion never leaves a dangling
    // reference behind.
    setItems((current) => current.filter((item) => item.id !== idToDelete));
    setDeleteTarget(null);
  }

  function handleSelectCollection(id: string) {
    setActiveCollectionId(id);
  }

  function handleOpenCreateCollection() {
    setCollectionDialogState({ mode: "create" });
  }

  function handleOpenEditCollection(collection: Collection) {
    setCollectionDialogState({ mode: "edit", collection });
  }

  function handleCloseCollectionDialog() {
    setCollectionDialogState(null);
  }

  function handleSubmitCollection(values: CollectionInput) {
    if (!collectionDialogState) return;

    if (collectionDialogState.mode === "edit") {
      const { id, itemIds, createdAt } = collectionDialogState.collection;
      setCollections((current) =>
        current.map((collection) =>
          collection.id === id
            ? { id, itemIds, createdAt, ...values, updatedAt: new Date().toISOString() }
            : collection,
        ),
      );
    } else {
      const newCollection: Collection = {
        id: generateId(),
        itemIds: [],
        createdAt: new Date().toISOString(),
        ...values,
      };
      setCollections((current) => [...current, newCollection]);
    }
    setCollectionDialogState(null);
  }

  function handleRequestDeleteCollection(collection: Collection) {
    setCollectionDeleteTarget(collection);
  }

  function handleCancelDeleteCollection() {
    setCollectionDeleteTarget(null);
  }

  function handleConfirmDeleteCollection() {
    if (!collectionDeleteTarget) return;
    const idToDelete = collectionDeleteTarget.id;
    setCollections((current) => current.filter((collection) => collection.id !== idToDelete));
    if (activeCollectionId === idToDelete) setActiveCollectionId(ALL_FILTER);
    setCollectionDeleteTarget(null);
  }

  function handleOpenMembershipDialog(item: LibraryItem) {
    setMembershipItem(item);
  }

  function handleCloseMembershipDialog() {
    setMembershipItem(null);
  }

  function handleToggleMembership(collectionId: string, checked: boolean) {
    if (!membershipItem) return;
    const itemId = membershipItem.id;
    setCollections((current) =>
      current.map((collection) => {
        if (collection.id !== collectionId) return collection;
        const itemIds = checked
          ? collection.itemIds.includes(itemId)
            ? collection.itemIds
            : [...collection.itemIds, itemId]
          : collection.itemIds.filter((id) => id !== itemId);
        return { ...collection, itemIds, updatedAt: new Date().toISOString() };
      }),
    );
  }

  function handleQuickCreateCollection(name: string) {
    if (!membershipItem) return;
    const newCollection: Collection = {
      id: generateId(),
      name,
      itemIds: [membershipItem.id],
      createdAt: new Date().toISOString(),
    };
    setCollections((current) => [...current, newCollection]);
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
            Collection
          </p>
          <CollectionFilterBar
            options={collectionOptions}
            activeId={activeCollectionId}
            onChange={handleSelectCollection}
            onCreateCollection={handleOpenCreateCollection}
          />
        </div>

        {activeCollection && (
          <CollectionHeader
            collection={activeCollection}
            itemCount={collectionItemIds?.size ?? 0}
            onEdit={() => handleOpenEditCollection(activeCollection)}
            onDeleteRequest={() => handleRequestDeleteCollection(activeCollection)}
          />
        )}

        <div className="mt-4">
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
            Status
          </p>
          <FilterTabs
            options={statusOptions}
            activeId={activeStatus}
            // Built entirely from ALL_FILTER + TRACKING_STATUSES in
            // getStatusOptions, so every id it can pass back is a valid
            // StatusFilterValue.
            onChange={(id) => setActiveStatus(id as StatusFilterValue)}
            ariaLabel="Filter library by status"
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
            activeStatus={activeStatus}
            activeCategory={activeCategory}
            activeTag={activeTag}
            collectionSize={collectionItemIds?.size}
            onToggleFavorite={handleToggleFavorite}
            onEdit={handleOpenEditDialog}
            onAddToCollection={handleOpenMembershipDialog}
            onDeleteRequest={handleDeleteRequest}
            onClearSearch={() => setSearchQuery("")}
            onClearTag={() => setActiveTag(null)}
            onTagClick={handleTagClick}
            onQuickIncrement={handleQuickIncrement}
          />
        </div>
      </main>

      <LibraryItemDialog
        state={dialogState}
        existingCategories={uniqueCategories}
        onSelectType={handleSelectType}
        onSelectSearchResult={handleSelectSearchResult}
        onManualEntry={handleManualEntry}
        onBackToPicker={handleBackToPicker}
        onBackToSearch={handleBackToSearch}
        onToggleFullForm={handleToggleFullForm}
        onClose={handleCloseDialog}
        onSubmitWebsite={handleSubmitWebsite}
        onSubmitMedia={handleSubmitMedia}
      />

      <DeleteLibraryItemDialog
        item={deleteTarget}
        onCancel={handleCancelDelete}
        onConfirm={handleConfirmDelete}
      />

      <CollectionDialog
        key={collectionDialogState?.mode === "edit" ? collectionDialogState.collection.id : "new-collection"}
        mode={collectionDialogState?.mode ?? "create"}
        collection={collectionDialogState?.mode === "edit" ? collectionDialogState.collection : undefined}
        existingCollections={collections}
        isOpen={collectionDialogState !== null}
        onSubmit={handleSubmitCollection}
        onClose={handleCloseCollectionDialog}
      />

      <DeleteCollectionDialog
        collection={collectionDeleteTarget}
        itemCount={collectionDeleteTarget ? getValidItemIds(collectionDeleteTarget, items).length : 0}
        onCancel={handleCancelDeleteCollection}
        onConfirm={handleConfirmDeleteCollection}
      />

      <CollectionMembershipDialog
        item={membershipItem}
        collections={collections}
        onToggleMembership={handleToggleMembership}
        onCreateCollection={handleQuickCreateCollection}
        onClose={handleCloseMembershipDialog}
      />
    </div>
  );
}
