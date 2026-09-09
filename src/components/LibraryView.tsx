"use client";

import { useEffect, useMemo, useState } from "react";
import type { LibraryItem, MediaItem, MediaItemInput, SupportedItemType, WebsiteItem, WebsiteItemInput } from "@/types/library-item";
import type { Collection, CollectionInput } from "@/types/collection";
import type { SavedSmartView, SmartViewDefinition } from "@/types/smart-view";
import { defaultSmartViewDefinition } from "@/types/smart-view";
import { Header } from "@/components/Header";
import { ImportBanner } from "@/components/ImportBanner";
import { PageContainer } from "@/components/PageContainer";
import { CollectionHeader } from "@/components/CollectionHeader";
import { CollectionDialog } from "@/components/CollectionDialog";
import { DeleteCollectionDialog } from "@/components/DeleteCollectionDialog";
import { CollectionMembershipDialog } from "@/components/CollectionMembershipDialog";
import { LibraryItemGrid } from "@/components/LibraryItemGrid";
import { LibraryItemDialog, type DialogState } from "@/components/LibraryItemDialog";
import { DeleteLibraryItemDialog } from "@/components/DeleteLibraryItemDialog";
import { LibrarySortSelect } from "@/components/LibrarySortSelect";
import { LibraryViewModeSwitcher } from "@/components/LibraryViewModeSwitcher";
import { useLibraryViewMode } from "@/hooks/useLibraryViewMode";
import { SmartViewsBar } from "@/components/SmartViewsBar";
import { LibraryFiltersPanel } from "@/components/LibraryFiltersPanel";
import { FilterChips } from "@/components/FilterChips";
import { SaveSmartViewDialog } from "@/components/SaveSmartViewDialog";
import { DeleteSmartViewDialog } from "@/components/DeleteSmartViewDialog";
import { SlidersIcon, SearchIcon } from "@/components/icons";
import { ALL_FILTER, FAVORITES_FILTER } from "@/lib/constants";
import { useAuth } from "@/components/AuthProvider";
import { DataErrorBanner } from "@/components/DataStatus";
import { EmptyState } from "@/components/EmptyState";
import { LibraryGridSkeleton } from "@/components/LibraryGridSkeleton";
import { useLibraryItems } from "@/hooks/useLibraryItems";
import { useCollections } from "@/hooks/useCollections";
import { useActivity } from "@/hooks/useActivity";
import { useSmartViews } from "@/hooks/useSmartViews";
import { useActivitySummary } from "@/hooks/useActivitySummary";
import { useReminders } from "@/hooks/useReminders";
import { useLocalImport } from "@/hooks/useLocalImport";
import { useLibraryActivation } from "@/hooks/useLibraryActivation";
import { getValidItemIds } from "@/lib/collections";
import { getCategories, getUniqueCategories, type TypeFilterValue } from "@/lib/library-items";
import {
  BUILT_IN_SMART_VIEWS,
  describeActiveFilters,
  filterSmartViewItems,
  findBuiltInSmartView,
  isDefaultSmartViewDefinition,
  removeFilterChip,
  smartViewDefinitionsEqual,
  sortSmartViewItems,
  type SmartViewContext,
} from "@/lib/smart-views";
import type { StatusFilterValue } from "@/lib/tracking";
import type { MetadataDetails } from "@/lib/metadata/types";
import { findDuplicateGroups, type DuplicateGroup } from "@/lib/duplicate-detection";
import { DuplicateMergeDialog } from "@/components/DuplicateMergeDialog";
import { UndoToast } from "@/components/UndoToast";
import { deleteItemWithRecovery, mergeItemsWithRecovery, undoRecoveryAction } from "@/lib/recovery-orchestration";
import { describeRecoveryAction, takePendingUndoToast } from "@/lib/library-recovery";

interface LibraryViewProps {
  items: LibraryItem[];
}

type CollectionDialogState = { mode: "create" } | { mode: "edit"; collection: Collection } | null;
type SaveViewDialogState = { mode: "create" } | { mode: "rename"; targetId: string } | null;

function describeSaveViewError(result: { status: string; reason?: string }): string {
  if (result.status === "duplicate_name") return "A view with this name already exists.";
  if (result.status === "invalid_name") {
    if (result.reason === "empty") return "View name is required.";
    if (result.reason === "too_long") return "View name is too long.";
    return "View name contains characters that aren't allowed.";
  }
  return "Couldn't save this view. Try again.";
}

export function LibraryView({ items: initialItems }: LibraryViewProps) {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const activity = useActivity(userId);
  const library = useLibraryItems(initialItems, activity.logEvent, userId);
  const { items } = library;
  const collectionsStore = useCollections(items, library.isHydrated, userId);
  const { collections } = collectionsStore;
  const smartViewsStore = useSmartViews(userId);
  const activitySummaryStore = useActivitySummary(userId, activity.events, activity.cloudWriteVersion);
  const remindersStore = useReminders(userId);
  const localImport = useLocalImport(userId);

  // See DashboardView for why cloud mode needs an explicit loading state
  // that local mode doesn't.
  const loading =
    Boolean(userId) &&
    (!library.isHydrated || !collectionsStore.isHydrated || !activity.isHydrated || !smartViewsStore.isHydrated || !activitySummaryStore.isHydrated);
  const loadError = library.error ?? collectionsStore.error ?? activity.error ?? smartViewsStore.error ?? activitySummaryStore.error;

  // Stage 35 (global consistency fix) — the same shared, page-independent
  // activation tracker DashboardView uses. A user can activate Markly for
  // the first time from Library's own empty-state CTA instead of
  // Dashboard's, and this records it identically either way (including
  // Auto Tracking nudge eligibility) — see hooks/useLibraryActivation.ts.
  const onboarding = useLibraryActivation({ loading, itemCount: items.length });

  function retryLoad() {
    library.reload();
    collectionsStore.reload();
    activity.reload();
    smartViewsStore.reload();
    activitySummaryStore.reload();
  }

  // ============================================================
  // Stage 31 — unified Smart View definition. The existing single-select
  // Type/Status/Collection tabs below are thin UI over the SAME
  // mediaTypes/statuses/collections array fields (always 0 or 1 elements
  // when driven only by those tabs) that the Filters panel exposes as
  // true multi-select — one filtering engine, never two parallel
  // implementations (§2). "All Library" is simply this definition at its
  // default value with no named view selected (§68) — selecting nothing
  // here reproduces every existing Library filter/sort/search behavior
  // exactly, unchanged.
  // ============================================================
  const [currentDefinition, setCurrentDefinition] = useState<SmartViewDefinition>(defaultSmartViewDefinition());
  const { viewMode, setViewMode } = useLibraryViewMode();
  const [selectedViewId, setSelectedViewId] = useState<string | null>(null);
  const [showFiltersPanel, setShowFiltersPanel] = useState(false);
  const [saveViewDialogState, setSaveViewDialogState] = useState<SaveViewDialogState>(null);
  const [saveViewError, setSaveViewError] = useState<string | undefined>();
  const [deleteViewTarget, setDeleteViewTarget] = useState<SavedSmartView | null>(null);

  const [selectedCategory, setSelectedCategory] = useState<string>(ALL_FILTER);
  const [dialogState, setDialogState] = useState<DialogState>(null);
  const [deleteTarget, setDeleteTarget] = useState<LibraryItem | null>(null);

  const [collectionDialogState, setCollectionDialogState] = useState<CollectionDialogState>(null);
  const [collectionDeleteTarget, setCollectionDeleteTarget] = useState<Collection | null>(null);
  const [membershipItem, setMembershipItem] = useState<LibraryItem | null>(null);
  const [reviewGroup, setReviewGroup] = useState<DuplicateGroup | null>(null);

  // Stage 28 — Undo toast for Delete/Merge. `undoToast` carries a live
  // recovery id (shows an Undo button); `resultToast` shows the outcome
  // of clicking it (or of an action with nothing to undo, e.g. a
  // cloud-mode error) and never has one. Auto-dismissed below.
  const [undoToast, setUndoToast] = useState<{ recoveryId: string; message: string } | null>(null);
  const [resultToast, setResultToast] = useState<string | null>(null);

  useEffect(() => {
    // One-shot hand-off from ItemDetailView, which deletes its own item
    // and redirects here — see setPendingUndoToast's doc comment.
    const pending = takePendingUndoToast();
    if (pending) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time read of a same-tab hand-off value (sessionStorage) on mount; the value can't be derived during render since sessionStorage isn't available at SSR time, and it must be consumed exactly once, not on every render.
      setUndoToast({ recoveryId: pending.recoveryId, message: describeRecoveryAction(pending.actionType, pending.title) });
    }
  }, []);

  useEffect(() => {
    if (!undoToast) return;
    const timer = setTimeout(() => setUndoToast(null), 8000);
    return () => clearTimeout(timer);
  }, [undoToast]);

  useEffect(() => {
    if (!resultToast) return;
    const timer = setTimeout(() => setResultToast(null), 5000);
    return () => clearTimeout(timer);
  }, [resultToast]);

  async function handleUndoClick() {
    if (!undoToast) return;
    const { recoveryId } = undoToast;
    setUndoToast(null);
    const result = await undoRecoveryAction(recoveryId, userId, library, collectionsStore, activity, activitySummaryStore, remindersStore);
    setResultToast(result.message);
  }

  // Stage 27 — pure, client-side, over items this view already has (see
  // README "Duplicate detection performance"). Never fuzzy — see
  // lib/duplicate-detection.ts.
  const duplicateGroups = useMemo(() => findDuplicateGroups(items), [items]);

  const smartViewContext: SmartViewContext = useMemo(
    () => ({ collections, activitySummary: activitySummaryStore.summary, now: new Date() }),
    [collections, activitySummaryStore.summary],
  );

  // Collection is the outermost facet — nothing scopes it.
  const rawCollectionScope = items;

  const activeCollectionTabId = currentDefinition.collections.length === 1 ? currentDefinition.collections[0] : ALL_FILTER;
  const activeCollection = useMemo(
    () => (activeCollectionTabId === ALL_FILTER ? undefined : collections.find((collection) => collection.id === activeCollectionTabId)),
    [collections, activeCollectionTabId],
  );

  // Type/Status no longer have their own quick-tab row (round 4 — that row
  // duplicated LibraryFiltersPanel's Media Type/Status checkboxes, which
  // read/write these exact same currentDefinition fields; see the doc
  // comment above currentDefinition's declaration). activeTypeTabId/
  // activeStatusTabId are still derived here since LibraryItemGrid's empty-
  // state copy keys off them.
  const activeTypeTabId: TypeFilterValue = currentDefinition.mediaTypes.length === 1 ? currentDefinition.mediaTypes[0] : ALL_FILTER;
  const activeStatusTabId: StatusFilterValue = currentDefinition.statuses.length === 1 ? currentDefinition.statuses[0] : ALL_FILTER;

  // Category is deliberately NOT part of SmartViewDefinition (Stage 31's
  // documented schema has no such field) — it stays its own independent,
  // unchanged ad-hoc dimension, composed as a final AND on top of
  // whatever the engine produces, exactly as before.
  const itemsBeforeCategory = useMemo(() => filterSmartViewItems(items, currentDefinition, smartViewContext), [items, currentDefinition, smartViewContext]);
  const uniqueCategories = useMemo(() => getUniqueCategories(itemsBeforeCategory), [itemsBeforeCategory]);
  const activeCategory =
    selectedCategory === ALL_FILTER || selectedCategory === FAVORITES_FILTER || uniqueCategories.includes(selectedCategory)
      ? selectedCategory
      : ALL_FILTER;
  const categories = useMemo(() => getCategories(itemsBeforeCategory), [itemsBeforeCategory]);

  const filteredItems = useMemo(
    () =>
      itemsBeforeCategory.filter((item) => {
        if (activeCategory === ALL_FILTER) return true;
        if (activeCategory === FAVORITES_FILTER) return item.favorite;
        return item.category === activeCategory;
      }),
    [itemsBeforeCategory, activeCategory],
  );

  const visibleItems = useMemo(
    () => sortSmartViewItems(filteredItems, currentDefinition.sort, smartViewContext.activitySummary),
    [filteredItems, currentDefinition.sort, smartViewContext.activitySummary],
  );

  const isAdHocOrViewActive = selectedViewId !== null || !isDefaultSmartViewDefinition(currentDefinition);
  const activeBuiltIn = selectedViewId ? findBuiltInSmartView(selectedViewId) : undefined;
  const activeSavedView = selectedViewId && !activeBuiltIn ? smartViewsStore.views.find((view) => view.id === selectedViewId) : undefined;
  const isModifiedFromSaved = activeSavedView ? !smartViewDefinitionsEqual(currentDefinition, activeSavedView.definition) : false;

  const filterChips = useMemo(() => describeActiveFilters(currentDefinition), [currentDefinition]);
  const activeTag = currentDefinition.tags.values[0] ?? null;

  const builtInViewEntries = useMemo(
    () => BUILT_IN_SMART_VIEWS.map((view) => ({ id: view.id, name: view.name, count: filterSmartViewItems(items, view.definition, smartViewContext).length })),
    [items, smartViewContext],
  );
  const customViewEntries = useMemo(
    () => smartViewsStore.views.map((view) => ({ id: view.id, name: view.name, count: filterSmartViewItems(items, view.definition, smartViewContext).length })),
    [items, smartViewContext, smartViewsStore.views],
  );

  function handleSelectView(id: string | null) {
    setSaveViewError(undefined);
    setShowFiltersPanel(false);
    if (id === null) {
      setSelectedViewId(null);
      setCurrentDefinition(defaultSmartViewDefinition());
      return;
    }
    const builtIn = findBuiltInSmartView(id);
    if (builtIn) {
      setSelectedViewId(id);
      setCurrentDefinition(builtIn.definition);
      return;
    }
    const saved = smartViewsStore.views.find((view) => view.id === id);
    if (saved) {
      setSelectedViewId(id);
      setCurrentDefinition(saved.definition);
    }
  }

  function handleSetCollectionTab(id: string) {
    setCurrentDefinition((current) => ({ ...current, collections: id === ALL_FILTER ? [] : [id] }));
  }

  function handleTagClick(tag: string) {
    setCurrentDefinition((current) => {
      const already = current.tags.values.some((existing) => existing.toLowerCase() === tag.toLowerCase());
      return { ...current, tags: { ...current.tags, values: already ? [] : [tag.toLowerCase()] } };
    });
  }

  function handleRemoveChip(chipId: string) {
    setCurrentDefinition((current) => removeFilterChip(current, chipId));
  }

  function handleClearAllFilters() {
    handleSelectView(null);
  }

  function handleOpenSaveAsView() {
    setSaveViewError(undefined);
    setSaveViewDialogState({ mode: "create" });
  }

  function handleRequestRenameView(id: string) {
    const view = smartViewsStore.views.find((candidate) => candidate.id === id);
    if (!view) return;
    setSaveViewError(undefined);
    setSaveViewDialogState({ mode: "rename", targetId: id });
  }

  function handleRequestDeleteView(id: string) {
    const view = smartViewsStore.views.find((candidate) => candidate.id === id);
    if (view) setDeleteViewTarget(view);
  }

  function handleConfirmDeleteView() {
    if (!deleteViewTarget) return;
    const wasActive = selectedViewId === deleteViewTarget.id;
    smartViewsStore.deleteView(deleteViewTarget.id);
    setDeleteViewTarget(null);
    // Stage 31 §69 — never leave a stale reference to a just-deleted view.
    if (wasActive) handleSelectView(null);
  }

  async function handleSubmitSaveViewDialog(name: string) {
    if (!saveViewDialogState) return;

    if (saveViewDialogState.mode === "rename") {
      const result = await smartViewsStore.updateView(saveViewDialogState.targetId, { name });
      if (result.status === "ok") {
        setSaveViewDialogState(null);
        setSaveViewError(undefined);
      } else {
        setSaveViewError(describeSaveViewError(result));
      }
      return;
    }

    const result = await smartViewsStore.createView(name, currentDefinition);
    if (result.status === "ok") {
      setSaveViewDialogState(null);
      setSaveViewError(undefined);
      setSelectedViewId(result.view.id);
    } else {
      setSaveViewError(describeSaveViewError(result));
    }
  }

  async function handleUpdateActiveView() {
    if (!activeSavedView) return;
    await smartViewsStore.updateView(activeSavedView.id, { definition: currentDefinition });
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

    if (dialogState.mode === "edit" && dialogState.item.type === "website") {
      library.updateWebsite(dialogState.item, values);
    } else {
      library.addWebsite(values);
    }
    setDialogState(null);
  }

  function handleSubmitMedia(values: MediaItemInput) {
    if (dialogState?.step !== "form" || dialogState.itemType === "website") return;

    if (dialogState.mode === "edit" && dialogState.item.type !== "website") {
      library.updateMedia(dialogState.item, values);
    } else {
      library.addMedia(dialogState.itemType, values);
    }
    setDialogState(null);
  }

  function handleDeleteRequest(item: LibraryItem) {
    setDeleteTarget(item);
  }

  function handleCancelDelete() {
    setDeleteTarget(null);
  }

  async function handleConfirmDelete() {
    if (!deleteTarget) return;
    const item = deleteTarget;
    setDeleteTarget(null);

    const result = await deleteItemWithRecovery(item, userId, library, collectionsStore, activity, remindersStore);
    if (!result.ok) {
      setResultToast(result.errorText ?? "Couldn't delete this item. Try again.");
      return;
    }
    if (result.handle) {
      setUndoToast({ recoveryId: result.handle.recoveryId, message: describeRecoveryAction(result.handle.actionType, result.handle.title) });
    }
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
      collectionsStore.updateCollection(collectionDialogState.collection.id, values);
    } else {
      collectionsStore.createCollection(values);
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
    collectionsStore.deleteCollection(idToDelete);
    if (activeCollectionTabId === idToDelete) handleSetCollectionTab(ALL_FILTER);
    setCollectionDeleteTarget(null);
  }

  /**
   * Stage 27's merge, orchestrated (together with its Stage 28 recovery
   * snapshot) by lib/recovery-orchestration.ts — see that module's doc
   * comment for the local-mode ordering hazard it exists to avoid.
   */
  async function handleMergeDuplicates(survivorId: string, duplicateId: string): Promise<{ ok: boolean; errorText?: string }> {
    const result = await mergeItemsWithRecovery(survivorId, duplicateId, userId, library, collectionsStore, activity, activitySummaryStore, remindersStore);
    if (result.ok && result.handle) {
      setUndoToast({ recoveryId: result.handle.recoveryId, message: describeRecoveryAction(result.handle.actionType, result.handle.title) });
    }
    return { ok: result.ok, errorText: result.errorText };
  }

  function handleOpenMembershipDialog(item: LibraryItem) {
    setMembershipItem(item);
  }

  function handleCloseMembershipDialog() {
    setMembershipItem(null);
  }

  function handleToggleMembership(collectionId: string, checked: boolean) {
    if (!membershipItem) return;
    collectionsStore.toggleMembership(collectionId, membershipItem.id, checked);
  }

  function handleQuickCreateCollection(name: string) {
    if (!membershipItem) return;
    collectionsStore.createCollection({ name }, membershipItem.id);
  }

  const activeViewName = activeBuiltIn?.name ?? activeSavedView?.name;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Header
        active="library"
        searchQuery={currentDefinition.query}
        onSearchQueryChange={(value) => setCurrentDefinition((current) => ({ ...current, query: value }))}
        onAddItem={handleOpenAddDialog}
      />
      <ImportBanner />

      <PageContainer>
        {loadError && (
          <div className="mb-4">
            <DataErrorBanner message={loadError} onRetry={retryLoad} />
          </div>
        )}

        {loading ? (
          <LibraryGridSkeleton />
        ) : (
          <>
            <SmartViewsBar
              builtInViews={builtInViewEntries}
              customViews={customViewEntries}
              allLibraryCount={items.length}
              activeViewId={selectedViewId}
              onSelect={handleSelectView}
              onRenameRequest={handleRequestRenameView}
              onDeleteRequest={handleRequestDeleteView}
            />

            {/* UI/UX quality pass, round 2 — Collection/Type/Status/Category
                quick-tabs and the advanced filter panel now share ONE
                "Filters" disclosure on every breakpoint (not just mobile):
                confirmed live these four rows alone pushed real library
                items ~800px+ down the page at 375px before a single item
                was visible, and desktop had the same four rows plus the
                separate advanced panel stacked before content. Smart Views,
                search (in Header), sort, and the active-filter chip summary
                stay always visible per the round-2 brief; everything else
                lives behind one toggle. No Stage 31 filtering capability
                was removed — same components, same handlers, same
                SmartViewDefinition, just grouped under one disclosure. */}
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => setShowFiltersPanel((current) => !current)}
                aria-expanded={showFiltersPanel}
                className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-hover"
              >
                <SlidersIcon width={14} height={14} />
                Filters
              </button>

              {isAdHocOrViewActive && !activeSavedView && (
                <button type="button" onClick={handleOpenSaveAsView} className="text-xs font-medium text-accent hover:underline">
                  Save as Smart View
                </button>
              )}
              {activeSavedView && !isModifiedFromSaved && (
                <button type="button" onClick={handleOpenSaveAsView} className="text-xs font-medium text-accent hover:underline">
                  Save as new view
                </button>
              )}

              <div className="ml-auto flex items-center gap-3">
                <LibraryViewModeSwitcher value={viewMode} onChange={setViewMode} />
                <LibrarySortSelect value={currentDefinition.sort} onChange={(sort) => setCurrentDefinition((current) => ({ ...current, sort }))} />
              </div>
            </div>

            {/* Round 6 — Category (no SmartViewDefinition equivalent — Stage
                31's schema deliberately excludes it, handled as its own
                ad-hoc dimension below) now renders as one more fieldset
                inside LibraryFiltersPanel instead of a separate row above
                it, so it reads as part of the filter set rather than an
                unrelated legacy control. Collection/Type/Status stay
                removed from any quick-tab row — they're the exact same
                currentDefinition.mediaTypes/statuses/collections fields
                the panel's tiles/chips already expose as multi-select. */}
            {showFiltersPanel && (
              <div className="mt-3">
                <LibraryFiltersPanel
                  definition={currentDefinition}
                  collections={collections}
                  categories={categories}
                  activeCategory={activeCategory}
                  onCategoryChange={setSelectedCategory}
                  onChange={setCurrentDefinition}
                  onCreateCollection={handleOpenCreateCollection}
                />
              </div>
            )}

            <div className="mt-3">
              <FilterChips chips={filterChips} onRemove={handleRemoveChip} onClearAll={handleClearAllFilters} />
            </div>

            {activeCollection && (
              <div className="mt-4">
                <CollectionHeader
                  collection={activeCollection}
                  itemCount={getValidItemIds(activeCollection, rawCollectionScope).length}
                  onEdit={() => handleOpenEditCollection(activeCollection)}
                  onDeleteRequest={() => handleRequestDeleteCollection(activeCollection)}
                />
              </div>
            )}

            {duplicateGroups.length > 0 && (
              <div className="mt-4 rounded-md border border-border bg-surface p-3">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground/70">
                  Potential duplicates · {duplicateGroups.length}
                </p>
                <ul className="mt-2 space-y-1">
                  {duplicateGroups.map((group) => (
                    <li key={group.key} className="flex items-center justify-between gap-3 text-sm">
                      <span className="min-w-0 truncate text-foreground">
                        {group.items[0].title} · {group.items.length} items
                      </span>
                      <button
                        type="button"
                        onClick={() => setReviewGroup(group)}
                        className="shrink-0 text-xs font-medium text-accent hover:underline"
                      >
                        Review
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {activeSavedView && isModifiedFromSaved && (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-surface-hover px-3 py-2">
                <p className="text-sm text-foreground">View modified</p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={handleOpenSaveAsView}
                    className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground hover:bg-surface"
                  >
                    Save as new
                  </button>
                  <button
                    type="button"
                    onClick={handleUpdateActiveView}
                    className="rounded-md bg-foreground px-2.5 py-1 text-xs font-medium text-background hover:bg-foreground/85"
                  >
                    Update view
                  </button>
                </div>
              </div>
            )}

            <div className="mt-4">
              {visibleItems.length === 0 && isAdHocOrViewActive ? (
                <EmptyState
                  icon={<SearchIcon width={22} height={22} />}
                  title={activeViewName ? `Nothing matches "${activeViewName}" yet` : "No items match this view."}
                  description="Try adjusting the filters."
                  action={{ label: "Clear filters", onClick: handleClearAllFilters }}
                />
              ) : (
                <LibraryItemGrid
                  items={visibleItems}
                  totalItems={items.length}
                  viewMode={viewMode}
                  searchQuery={currentDefinition.query}
                  activeType={activeTypeTabId}
                  activeStatus={activeStatusTabId}
                  activeCategory={activeCategory}
                  activeTag={activeTag}
                  collectionSize={activeCollection ? getValidItemIds(activeCollection, rawCollectionScope).length : undefined}
                  onAddItem={handleOpenAddDialog}
                  showAniListPath={Boolean(user)}
                  showExtensionPath={Boolean(user)}
                  pendingLocalImport={localImport.hasPendingImport}
                  hasEverHadLibraryItems={onboarding.hasEverHadLibraryItems}
                  onToggleFavorite={library.toggleFavorite}
                  onEdit={handleOpenEditDialog}
                  onAddToCollection={handleOpenMembershipDialog}
                  onDeleteRequest={handleDeleteRequest}
                  onClearSearch={() => setCurrentDefinition((current) => ({ ...current, query: "" }))}
                  onClearTag={() => setCurrentDefinition((current) => ({ ...current, tags: { ...current.tags, values: [] } }))}
                  onTagClick={handleTagClick}
                  onQuickIncrement={library.quickIncrementProgress}
                />
              )}
            </div>
          </>
        )}
      </PageContainer>

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

      {reviewGroup && (
        <DuplicateMergeDialog
          key={reviewGroup.key}
          group={reviewGroup}
          collections={collections}
          onMerge={handleMergeDuplicates}
          onClose={() => setReviewGroup(null)}
        />
      )}

      <SaveSmartViewDialog
        mode={saveViewDialogState?.mode ?? "create"}
        isOpen={saveViewDialogState !== null}
        initialName={saveViewDialogState?.mode === "rename" ? smartViewsStore.views.find((view) => view.id === saveViewDialogState.targetId)?.name : undefined}
        externalError={saveViewError}
        onSubmit={handleSubmitSaveViewDialog}
        onClose={() => {
          setSaveViewDialogState(null);
          setSaveViewError(undefined);
        }}
      />

      <DeleteSmartViewDialog view={deleteViewTarget} onCancel={() => setDeleteViewTarget(null)} onConfirm={handleConfirmDeleteView} />

      {undoToast && <UndoToast message={undoToast.message} onUndo={handleUndoClick} onDismiss={() => setUndoToast(null)} />}
      {!undoToast && resultToast && <UndoToast message={resultToast} onDismiss={() => setResultToast(null)} />}
    </div>
  );
}
