"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { MediaItemInput, WebsiteItemInput } from "@/types/library-item";
import type { ContinueReminder } from "@/types/reminder";
import type { TrackingSourceSummary } from "@/lib/extension/types";
import { ITEM_TYPE_LABELS } from "@/types/library-item";
import { useAuth } from "@/components/AuthProvider";
import { DataErrorBanner } from "@/components/DataStatus";
import { useLibraryItems } from "@/hooks/useLibraryItems";
import { useCollections } from "@/hooks/useCollections";
import { useActivity } from "@/hooks/useActivity";
import { useReminders } from "@/hooks/useReminders";
import { resolveResumeTarget, type ResumeTarget } from "@/lib/resume";
import { SourceChooserDialog } from "@/components/SourceChooserDialog";
import { PageContainer } from "@/components/PageContainer";
import { IconButton } from "@/components/IconButton";
import { getDomain, getFaviconUrl } from "@/lib/website";
import {
  formatDate,
  getCatalogMetadataRows,
  getProviderLabel,
  isMediaItem,
  isSupportedLibraryItem,
} from "@/lib/item-detail";
import { SecondaryPageHeader } from "@/components/SecondaryPageHeader";
import { ItemCover } from "@/components/ItemCover";
import { ItemDetailSkeleton } from "@/components/ItemDetailSkeleton";
import { ItemTrackingSection } from "@/components/ItemTrackingSection";
import { ItemTrackingSourcesSection } from "@/components/ItemTrackingSourcesSection";
import { ItemMetadataRows } from "@/components/ItemMetadataRows";
import { ItemCollectionsSection } from "@/components/ItemCollectionsSection";
import { ItemActivitySection } from "@/components/ItemActivitySection";
import { ItemActionsMenu } from "@/components/ItemActionsMenu";
import { LibraryItemDialog, type DialogState } from "@/components/LibraryItemDialog";
import { DeleteLibraryItemDialog } from "@/components/DeleteLibraryItemDialog";
import { CollectionMembershipDialog } from "@/components/CollectionMembershipDialog";
import { UndoToast } from "@/components/UndoToast";
import { RemindMeContinueDialog } from "@/components/RemindMeContinueDialog";
import { deleteItemWithRecovery } from "@/lib/recovery-orchestration";
import { setPendingUndoToast } from "@/lib/library-recovery";
import { BellIcon, ExternalLinkIcon, GlobeIcon, StarIcon } from "@/components/icons";

interface ItemDetailViewProps {
  itemId: string;
}

function noop() {}

function DetailShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <SecondaryPageHeader maxWidthClassName="max-w-4xl" />
      <PageContainer width="detail" paddingY="py-8">
        {children}
      </PageContainer>
    </div>
  );
}

export function ItemDetailView({ itemId }: ItemDetailViewProps) {
  const router = useRouter();
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const activity = useActivity(userId);
  const library = useLibraryItems([], activity.logEvent, userId);
  const collectionsStore = useCollections(library.items, library.isHydrated, userId);
  const remindersStore = useReminders(userId);
  const [dialogState, setDialogState] = useState<DialogState>(null);
  const [deleteRequested, setDeleteRequested] = useState(false);
  const [membershipOpen, setMembershipOpen] = useState(false);
  const [remindMeOpen, setRemindMeOpen] = useState(false);
  const [chooserOpen, setChooserOpen] = useState(false);
  // Stage 28 — this page navigates away immediately after a successful
  // delete, so its own Undo toast can't persist here; instead it hands the
  // recovery id off to /library via setPendingUndoToast and only shows a
  // toast itself for an outcome that keeps the user on this page (a
  // failed delete).
  const [resultToast, setResultToast] = useState<string | null>(null);

  useEffect(() => {
    if (!resultToast) return;
    const timer = setTimeout(() => setResultToast(null), 5000);
    return () => clearTimeout(timer);
  }, [resultToast]);

  // Stage 41 — this page's own primary Continue/Open action goes through
  // the same lib/resume.ts engine Dashboard uses, which needs this item's
  // linked TrackingSources.
  //
  // Stage 41.2 — this is now the ONE fetch and the ONE state for this
  // item's TrackingSources on this page. A production live test found
  // that ItemDetailView and ItemTrackingSourcesSection previously each
  // fetched and held their own independent copy: Add Source / Unlink
  // updated only the section's local copy, so this page's own primary
  // Continue button could keep showing a stale target (or none) until a
  // reload. ItemTrackingSourcesSection is now a controlled component —
  // it receives `trackingSources` as a prop and reports every add/link/
  // unlink/toggle back through `handleSourcesChange`, so both the primary
  // action above and the Sources list below always render from the exact
  // same array, in the same render pass, with no reload and no polling.
  //
  // `null` means "we do not yet/no longer authoritatively know this
  // item's TrackingSource set" — covering both initial loading AND a
  // failed fetch (Stage 41.4: a failed fetch is NOT the same as a
  // confirmed-zero result, so it must not be silently promoted to `[]`
  // either — see the `sourceStateUnknown` gate below, which is the actual
  // consumer of this distinction).
  const [trackingSources, setTrackingSources] = useState<TrackingSourceSummary[] | null>(null);
  useEffect(() => {
    // No setState here for the signed-out case: the gate below already
    // treats a permanently-null trackingSources as "not applicable" (not
    // "unknown") whenever userId is null — there's nothing to reset, so
    // this stays a pure "fetch and subscribe" body with no synchronous
    // setState call in it.
    if (!userId) return;
    let cancelled = false;
    fetch(`/api/tracking-sources?libraryItemId=${encodeURIComponent(itemId)}`)
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("failed"))))
      .then((data: { sources: TrackingSourceSummary[] }) => {
        if (!cancelled) setTrackingSources(data.sources);
      })
      .catch(() => {
        // Stage 41.4 — a failed fetch tells us nothing about the real
        // TrackingSource set; leaving/resetting to `null` (never `[]`)
        // keeps that honest instead of quietly claiming "confirmed zero".
        if (!cancelled) setTrackingSources(null);
      });
    return () => {
      cancelled = true;
    };
  }, [itemId, userId]);

  if (!library.isHydrated) {
    return (
      <DetailShell>
        <ItemDetailSkeleton />
      </DetailShell>
    );
  }

  const loadError = library.error ?? collectionsStore.error ?? activity.error;

  const item = library.items.find((candidate) => candidate.id === itemId);

  if (!item) {
    return (
      <DetailShell>
        <div className="flex flex-col items-center gap-3 py-20 text-center">
          <span className="text-muted-foreground">
            <GlobeIcon width={22} height={22} />
          </span>
          <p className="text-sm font-medium text-foreground">Item not found</p>
          <p className="max-w-xs text-sm text-muted-foreground">
            This item does not exist in your local Markly library.
          </p>
          <Link
            href="/library"
            className="mt-1 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            Back to Library
          </Link>
        </div>
      </DetailShell>
    );
  }

  // Narrows LibraryItem down to MediaItem for the six real trackable types;
  // null for "website" and for the (never actually created) generic
  // placeholder type, so the JSX below can use `media` directly instead of
  // repeatedly re-checking `item.type !== "website"`, which alone can't
  // fully narrow the union (the generic type is also a union member).
  const media = isMediaItem(item) ? item : null;

  // `itemId` (the route param, a plain string prop) is used below rather
  // than `item.id` — TypeScript doesn't retain the `if (!item) return`
  // narrowing of `item` itself inside the function declarations further
  // down (closures aren't assumed to run at the same point in control flow
  // as where they're defined), but the two are guaranteed equal since
  // `item` was found by matching this exact id.
  const itemCollections = collectionsStore.collections.filter((collection) => collection.itemIds.includes(itemId));
  // Stage 41 — the one authoritative Continue/Resume/Open decision (see
  // lib/resume.ts). Replaces this page's own previous, independent
  // "media?.sourceUrl direct" primitive, which never consulted
  // TrackingSources at all — a real gap the Stage 41 audit found (an item
  // with zero manually-entered sourceUrl but a linked Source Hub source
  // previously showed no primary action whatsoever).
  //
  // Stage 41.4 (CRITICAL) — `trackingSources ?? []` alone is not safe: []
  // means "an authoritative fetch confirmed zero linked sources" (which
  // legitimately unlocks resolveResumeTarget's own item.sourceUrl
  // canonical_url fallback), while `null` means "we don't actually know
  // yet" (still loading, or a mutation succeeded but its reconciling
  // refresh failed — Stage 41.3). Silently treating null as [] would let
  // that canonical fallback leak through as an authoritative-looking
  // resume target during a window where the real TrackingSource set is
  // unknown and could in fact be ambiguous (e.g. mid-reconciliation after
  // adding a second source). This gate applies ONLY to authenticated
  // trackable media: website items never read the second argument at all
  // (resolveResumeTarget's own first branch resolves them purely from
  // item.url), and signed-out/local media has no cloud TrackingSource
  // concept to be "unknown" about — trackingSources stays permanently
  // null there by design, which correctly means "not applicable", not
  // "not yet known", so local mode's existing sourceUrl fallback is
  // untouched.
  const sourceStateUnknown = userId !== null && media !== null && trackingSources === null;
  const resumeTarget: ResumeTarget = sourceStateUnknown
    ? { kind: "unavailable", reason: "no-target" }
    : resolveResumeTarget(item, trackingSources ?? []);
  const addedDate = formatDate(item.createdAt);
  const updatedDate = formatDate(item.updatedAt);
  const genres = media && "genres" in media && media.genres ? media.genres : [];
  // Display-only dedup — never mutates item.tags. A tag identical to a
  // genre (case-insensitive) is redundant to show twice on the same page.
  const distinctTags = item.tags.filter((tag) => !genres.some((genre) => genre.toLowerCase() === tag.toLowerCase()));
  // Catalog-derived items get their category from the same genre list
  // (see deriveCategoryAndTags) — category ends up literally "the first
  // genre." Same display-only rule as tags above: never mutate
  // item.category, just don't show it a second time when it's redundant
  // with a genre already on screen. A manually-entered or otherwise
  // distinct category still renders normally.
  const trimmedCategory = item.category.trim();
  const categoryDuplicatesGenre = trimmedCategory !== "" && genres.some((genre) => genre.trim().toLowerCase() === trimmedCategory.toLowerCase());
  const showCategory = trimmedCategory !== "" && !categoryDuplicatesGenre;
  const hasDetails = genres.length > 0 || distinctTags.length > 0 || showCategory;

  function handleToggleFullForm() {
    if (dialogState?.step !== "form") return;
    setDialogState({ ...dialogState, showFullForm: true });
  }

  function handleOpenEdit() {
    // Re-check freshly rather than relying on the outer `item`/narrowing —
    // closures don't retain control-flow narrowing from an enclosing scope.
    const current = library.items.find((candidate) => candidate.id === itemId);
    if (!current || !isSupportedLibraryItem(current)) return;
    setDialogState({ step: "form", mode: "edit", itemType: current.type, item: current });
  }

  function handleSubmitWebsite(values: WebsiteItemInput) {
    if (dialogState?.step !== "form" || dialogState.mode !== "edit" || dialogState.item.type !== "website") return;
    library.updateWebsite(dialogState.item, values);
    setDialogState(null);
  }

  function handleSubmitMedia(values: MediaItemInput) {
    if (dialogState?.step !== "form" || dialogState.mode !== "edit" || dialogState.item.type === "website") return;
    library.updateMedia(dialogState.item, values);
    setDialogState(null);
  }

  async function handleConfirmDelete() {
    setDeleteRequested(false);
    const current = library.items.find((candidate) => candidate.id === itemId);
    if (!current) return;
    const result = await deleteItemWithRecovery(current, userId, library, collectionsStore, activity, remindersStore);
    if (!result.ok) {
      setResultToast(result.errorText ?? "Couldn't delete this item. Try again.");
      return;
    }
    if (result.handle) setPendingUndoToast(result.handle);
    router.push("/library");
  }

  function handleToggleMembership(collectionId: string, checked: boolean) {
    collectionsStore.toggleMembership(collectionId, itemId, checked);
  }

  function handleQuickCreateCollection(name: string) {
    collectionsStore.createCollection({ name }, itemId);
  }

  function retryLoad() {
    library.reload();
    collectionsStore.reload();
    activity.reload();
  }

  return (
    <DetailShell>
      {loadError && (
        <div className="mb-6">
          <DataErrorBanner message={loadError} onRetry={retryLoad} />
        </div>
      )}

      <div className="flex flex-col gap-6 sm:flex-row">
        <div className="shrink-0 sm:w-56">
          {item.type === "website" ? (
            <div className="flex aspect-[2/3] w-full max-w-[200px] items-center justify-center overflow-hidden rounded-lg border border-border bg-muted sm:max-w-[220px]">
              <FaviconOrGlobe url={item.url} />
            </div>
          ) : (
            media && <ItemCover item={media} />
          )}
        </div>

        <div className="min-w-0 flex-1 space-y-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground/70">
              {media?.releaseYear ? `${ITEM_TYPE_LABELS[item.type]} • ${media.releaseYear}` : ITEM_TYPE_LABELS[item.type]}
            </p>
            <div className="mt-1 flex items-start justify-between gap-3">
              <h1 className="min-w-0 break-words text-xl font-semibold text-foreground">{item.title}</h1>
              <div className="flex shrink-0 items-center gap-0.5">
                <IconButton
                  onClick={() => library.toggleFavorite(item.id)}
                  aria-pressed={item.favorite}
                  aria-label={item.favorite ? `Remove ${item.title} from favorites` : `Add ${item.title} to favorites`}
                  active={item.favorite}
                  icon={<StarIcon filled={item.favorite} width={20} height={20} />}
                />
                {media && (
                  <IconButton
                    onClick={() => setRemindMeOpen(true)}
                    aria-label={`Remind me to continue ${item.title}`}
                    icon={<BellIcon width={18} height={18} />}
                  />
                )}
                <ItemActionsMenu
                  label={item.title}
                  editLabel="Edit item"
                  deleteLabel="Delete item"
                  onEdit={handleOpenEdit}
                  onDeleteRequest={() => setDeleteRequested(true)}
                />
              </div>
            </div>
            {item.type === "website" && (
              <p className="mt-1 truncate text-sm text-muted-foreground">{getDomain(item.url)}</p>
            )}
          </div>

          {/* UI/UX quality pass — the primary action (Open Source/Website)
              used to render AFTER tracking controls, the source list, and
              catalog metadata rows — a user had to scroll past several
              secondary sections to find "the" thing to click. Promoted to
              right below the title/identity block, matching the brief's
              "Continue/Open source should be easy to identify" — every
              other section keeps its exact existing content, only the
              external-link CTA moved. Stage 41 — now driven by
              lib/resume.ts's resolveResumeTarget rather than a raw
              sourceUrl read; see resumeTarget's own computation above. */}
          {(resumeTarget.kind === "direct" || resumeTarget.kind === "canonical_url") && (
            <div className="flex flex-wrap items-center gap-2">
              <a
                href={resumeTarget.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 rounded-md bg-foreground px-3.5 py-2 text-sm font-medium text-background transition-colors hover:bg-foreground/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                <ExternalLinkIcon width={15} height={15} />
                {resumeTarget.actionLabel}
              </a>
            </div>
          )}

          {resumeTarget.kind === "choose_source" && (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setChooserOpen(true)}
                className="flex items-center gap-1.5 rounded-md bg-foreground px-3.5 py-2 text-sm font-medium text-background transition-colors hover:bg-foreground/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                {resumeTarget.actionLabel}
              </button>
              <SourceChooserDialog
                isOpen={chooserOpen}
                onClose={() => setChooserOpen(false)}
                itemTitle={item.title}
                sources={resumeTarget.sources}
              />
            </div>
          )}

          {media && (
            <ItemTrackingSection
              item={media}
              onIncrementProgress={library.quickIncrementProgress}
              onAdjustPlaytime={library.quickAdjustPlaytime}
              onUpdateNovelProgress={library.quickSetNovelProgress}
              onSaveTracking={library.updateTracking}
            />
          )}

          {media && (
            <ItemTrackingSourcesSection
              itemId={itemId}
              userId={userId}
              sources={trackingSources}
              onSourcesChange={setTrackingSources}
            />
          )}

          {media && <ItemMetadataRows rows={getCatalogMetadataRows(media)} />}
        </div>
      </div>

      <div className="mt-8 space-y-6 border-t border-border pt-6">
        {item.description && (
          <section>
            <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">About</h2>
            <p className="whitespace-pre-line text-sm leading-relaxed text-muted-foreground">{item.description}</p>
          </section>
        )}

        {hasDetails && (
          <section className="space-y-3">
            <h2 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">Details</h2>

            {genres.length > 0 && (
              <div>
                <p className="mb-1.5 text-xs text-muted-foreground">Genres</p>
                <div className="flex flex-wrap gap-1.5">
                  {genres.map((genre) => (
                    <span key={genre} className="rounded border border-border px-2 py-0.5 text-xs text-muted-foreground">
                      {genre}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {distinctTags.length > 0 && (
              <div>
                <p className="mb-1.5 text-xs text-muted-foreground">Tags</p>
                <div className="flex flex-wrap gap-1.5">
                  {distinctTags.map((tag) => (
                    <span key={tag} className="rounded border border-border px-2 py-0.5 text-xs text-muted-foreground">
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {showCategory && (
              <p className="text-xs text-muted-foreground">
                Category: <span className="text-foreground">{item.category}</span>
              </p>
            )}
          </section>
        )}

        <ItemCollectionsSection collections={itemCollections} onManage={() => setMembershipOpen(true)} />

        <ItemActivitySection events={activity.getEventsForItem(itemId)} item={item} />

        <div className="space-y-0.5 text-xs text-muted-foreground">
          {media?.catalogSource && <p>Metadata source: {getProviderLabel(media.catalogSource.provider)}</p>}
          <p>
            {addedDate && <>Added {addedDate}</>}
            {addedDate && updatedDate && " · "}
            {updatedDate && <>Updated {updatedDate}</>}
          </p>
        </div>
      </div>

      <LibraryItemDialog
        state={dialogState}
        existingCategories={[]}
        onSelectType={noop}
        onSelectSearchResult={noop}
        onManualEntry={noop}
        onBackToPicker={noop}
        onBackToSearch={noop}
        onToggleFullForm={handleToggleFullForm}
        onClose={() => setDialogState(null)}
        onSubmitWebsite={handleSubmitWebsite}
        onSubmitMedia={handleSubmitMedia}
      />

      <DeleteLibraryItemDialog
        item={deleteRequested ? item : null}
        onCancel={() => setDeleteRequested(false)}
        onConfirm={handleConfirmDelete}
      />

      <CollectionMembershipDialog
        item={membershipOpen ? item : null}
        collections={collectionsStore.collections}
        onToggleMembership={handleToggleMembership}
        onCreateCollection={handleQuickCreateCollection}
        onClose={() => setMembershipOpen(false)}
      />

      {resultToast && <UndoToast message={resultToast} onDismiss={() => setResultToast(null)} />}

      {media && (
        <RemindMeContinueDialog
          isOpen={remindMeOpen}
          libraryItemId={item.id}
          itemTitle={item.title}
          existing={
            remindersStore.reminders.find(
              (reminder): reminder is ContinueReminder => reminder.kind === "continue" && reminder.libraryItemId === item.id && !reminder.dismissedAt,
            ) ?? null
          }
          onClose={() => setRemindMeOpen(false)}
          onCreate={(libraryItemId, remindAt) => remindersStore.createReminder({ kind: "continue", libraryItemId, remindAt })}
          onUpdateTime={remindersStore.updateContinueTime}
        />
      )}
    </DetailShell>
  );
}

function FaviconOrGlobe({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  const domain = getDomain(url);

  if (failed) {
    return <GlobeIcon width={40} height={40} className="text-muted-foreground" aria-hidden="true" />;
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- favicon is a third-party, per-domain image; next/image's optimizer isn't a good fit here.
    <img src={getFaviconUrl(domain)} alt="" width={40} height={40} onError={() => setFailed(true)} />
  );
}
