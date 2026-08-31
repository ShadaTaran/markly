"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { MediaItemInput, WebsiteItemInput } from "@/types/library-item";
import { ITEM_TYPE_LABELS } from "@/types/library-item";
import { useLibraryItems } from "@/hooks/useLibraryItems";
import { useCollections } from "@/hooks/useCollections";
import { useActivity } from "@/hooks/useActivity";
import { getDomain, getFaviconUrl } from "@/lib/website";
import {
  formatDate,
  getCatalogMetadataRows,
  getProviderLabel,
  isMediaItem,
  isSupportedLibraryItem,
} from "@/lib/item-detail";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ItemCover } from "@/components/ItemCover";
import { ItemTrackingSection } from "@/components/ItemTrackingSection";
import { ItemMetadataRows } from "@/components/ItemMetadataRows";
import { ItemCollectionsSection } from "@/components/ItemCollectionsSection";
import { ItemActivitySection } from "@/components/ItemActivitySection";
import { ItemActionsMenu } from "@/components/ItemActionsMenu";
import { LibraryItemDialog, type DialogState } from "@/components/LibraryItemDialog";
import { DeleteLibraryItemDialog } from "@/components/DeleteLibraryItemDialog";
import { CollectionMembershipDialog } from "@/components/CollectionMembershipDialog";
import { ArrowLeftIcon, ExternalLinkIcon, GlobeIcon, StarIcon } from "@/components/icons";

interface ItemDetailViewProps {
  itemId: string;
}

function noop() {}

function DetailShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-4xl items-center gap-4 px-4 py-4 sm:px-6 lg:px-8">
          <Link
            href="/library"
            className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <ArrowLeftIcon width={16} height={16} />
            Back to Library
          </Link>
          <div className="ml-auto">
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">{children}</main>
    </div>
  );
}

export function ItemDetailView({ itemId }: ItemDetailViewProps) {
  const router = useRouter();
  const activity = useActivity();
  const library = useLibraryItems([], activity.logEvent);
  const collectionsStore = useCollections(library.items, library.isHydrated);
  const [dialogState, setDialogState] = useState<DialogState>(null);
  const [deleteRequested, setDeleteRequested] = useState(false);
  const [membershipOpen, setMembershipOpen] = useState(false);

  if (!library.isHydrated) {
    return <DetailShell>{null}</DetailShell>;
  }

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
  const externalUrl = item.type === "website" ? item.url : media?.sourceUrl;
  const externalLinkLabel = item.type === "website" ? "Open Website" : "Open Source";
  const addedDate = formatDate(item.createdAt);
  const updatedDate = formatDate(item.updatedAt);

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

  function handleConfirmDelete() {
    library.deleteItem(itemId);
    // Deleting an item also removes its activity history — an orphaned
    // history entry for a now-nonexistent item has no use, and this keeps
    // markly.activity from growing unboundedly with dead references.
    activity.removeEventsForItem(itemId);
    setDeleteRequested(false);
    router.push("/library");
  }

  function handleToggleMembership(collectionId: string, checked: boolean) {
    collectionsStore.toggleMembership(collectionId, itemId, checked);
  }

  function handleQuickCreateCollection(name: string) {
    collectionsStore.createCollection({ name }, itemId);
  }

  return (
    <DetailShell>
      <div className="flex flex-col gap-6 sm:flex-row">
        <div className="shrink-0 sm:w-56">
          {item.type === "website" ? (
            <div className="flex aspect-[2/3] w-full max-w-[200px] items-center justify-center overflow-hidden rounded-lg border border-border bg-surface sm:max-w-[220px]">
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
                <button
                  type="button"
                  onClick={() => library.toggleFavorite(item.id)}
                  aria-pressed={item.favorite}
                  aria-label={item.favorite ? `Remove ${item.title} from favorites` : `Add ${item.title} to favorites`}
                  className="rounded p-1.5 text-muted-foreground transition-colors hover:text-amber-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 data-[favorite=true]:text-amber-500"
                  data-favorite={item.favorite}
                >
                  <StarIcon filled={item.favorite} width={20} height={20} />
                </button>
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

          {media && (
            <ItemTrackingSection
              item={media}
              onIncrementProgress={library.quickIncrementProgress}
              onAdjustPlaytime={library.quickAdjustPlaytime}
              onUpdateNovelProgress={library.quickSetNovelProgress}
              onSaveTracking={library.updateTracking}
            />
          )}

          {media && <ItemMetadataRows rows={getCatalogMetadataRows(media)} />}

          {externalUrl && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <a
                href={externalUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 rounded-md bg-foreground px-3.5 py-2 text-sm font-medium text-background transition-colors hover:bg-foreground/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                <ExternalLinkIcon width={15} height={15} />
                {externalLinkLabel}
              </a>
            </div>
          )}
        </div>
      </div>

      <div className="mt-8 space-y-6 border-t border-border pt-6">
        {item.description && (
          <section>
            <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
              Description
            </h2>
            <p className="whitespace-pre-line text-sm leading-relaxed text-muted-foreground">{item.description}</p>
          </section>
        )}

        {media && "genres" in media && media.genres && media.genres.length > 0 && (
          <section>
            <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
              Genres
            </h2>
            <div className="flex flex-wrap gap-1.5">
              {media.genres.map((genre) => (
                <span key={genre} className="rounded border border-border px-2 py-0.5 text-xs text-muted-foreground">
                  {genre}
                </span>
              ))}
            </div>
          </section>
        )}

        {item.tags.length > 0 && (
          <section>
            <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">Tags</h2>
            <div className="flex flex-wrap gap-1.5">
              {item.tags.map((tag) => (
                <span key={tag} className="rounded border border-border px-2 py-0.5 text-xs text-muted-foreground">
                  {tag}
                </span>
              ))}
            </div>
          </section>
        )}

        {item.category && (
          <p className="text-xs text-muted-foreground">
            Category: <span className="text-foreground">{item.category}</span>
          </p>
        )}

        <ItemCollectionsSection collections={itemCollections} onManage={() => setMembershipOpen(true)} />

        <ItemActivitySection events={activity.getEventsForItem(itemId)} item={item} />

        {media?.catalogSource && (
          <p className="text-xs text-muted-foreground">
            Metadata source: {getProviderLabel(media.catalogSource.provider)}
          </p>
        )}

        <p className="text-xs text-muted-foreground">
          {addedDate && <>Added {addedDate}</>}
          {addedDate && updatedDate && " · "}
          {updatedDate && <>Updated {updatedDate}</>}
        </p>
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
