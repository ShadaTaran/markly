"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { LibraryItem, MediaItem, SupportedItemType, WebsiteItemInput, MediaItemInput } from "@/types/library-item";
import type { MetadataDetails } from "@/lib/metadata/types";
import { useAuth } from "@/components/AuthProvider";
import { useActivity } from "@/hooks/useActivity";
import { useLibraryItems } from "@/hooks/useLibraryItems";
import { useLocalImport } from "@/hooks/useLocalImport";
import { useLibraryActivation } from "@/hooks/useLibraryActivation";
import { resolveActivationState } from "@/lib/onboarding";
import { getDomain, normalizeUrl } from "@/lib/website";
import { getUniqueCategories } from "@/lib/library-items";
import { extractShareUrl, extractShareTitle, truncateForDisplay } from "@/lib/share/extract-share-url";
import { ItemTypePicker } from "@/components/ItemTypePicker";
import { MetadataSearchPanel } from "@/components/MetadataSearchPanel";
import { WebsiteItemForm } from "@/components/WebsiteItemForm";
import { MediaItemForm, type DetectedPrefill } from "@/components/MediaItemForm";
import { CatalogTrackingForm, type PersonalTrackingValues } from "@/components/CatalogTrackingForm";
import { buildCatalogDisplayFromPrefill, buildCatalogMediaInput } from "@/lib/metadata/catalog-item";
import { Field, inputClass } from "@/components/FormField";
import { Button } from "@/components/Button";

/**
 * Stage 39 — Share to Markly. Deliberately its OWN small orchestrator
 * rather than a modification of LibraryItemDialog (the shared modal Library/
 * Dashboard's own Add Item flow uses): reuses every leaf component
 * (ItemTypePicker, MetadataSearchPanel, WebsiteItemForm, MediaItemForm,
 * CatalogTrackingForm) and the exact same useLibraryItems mutations, but
 * with a page-local state machine so seeding a shared URL/title never
 * requires threading new fields through LibraryItemDialog's shared,
 * heavily-relied-on DialogState type. Zero risk to the existing Library/
 * Dashboard Add Item flow.
 *
 * Nothing here is written to localStorage/the database until the user
 * explicitly submits a form (Stage 39 §11) — a cancelled/abandoned share
 * leaves no trace.
 */

type Step =
  | { kind: "no-payload" }
  /** A share arrived (title/text present) but no usable URL was ever found — genuinely absent, never a rejected one (Stage 39 correction §2). */
  | { kind: "missing" }
  /** A URL was supplied (explicitly, or as the sole text-derived candidate) but failed validation — never conflated with "missing" (Stage 39 correction §1/§3). */
  | { kind: "invalid" }
  | { kind: "existing-item"; item: LibraryItem }
  /** Stage 40 §20/§22 — shown after a NEW media item is created through the share flow, only when there's a URL that isn't already the item's own field. Explicit opt-in only; skipping leaves the item exactly as created. */
  | { kind: "link-source-prompt"; itemId: string; url: string }
  | { kind: "review" }
  | { kind: "pickType" }
  | { kind: "search"; itemType: SupportedItemType }
  | { kind: "form-website" }
  | { kind: "form-media"; itemType: SupportedItemType; prefill?: MetadataDetails; detected?: DetectedPrefill; showFullForm?: boolean };

function isWebsite(item: LibraryItem): item is Extract<LibraryItem, { type: "website" }> {
  return item.type === "website";
}

/** The one exact, high-confidence "you already have this" signal (Stage 39 §15/§23): a website's own url, or a media item's optional sourceUrl, normalized-equal to the shared link. Never fuzzy, never partial — the same conservative bar duplicate-detection.ts already holds pre-hoc detection to. */
function findItemByExactUrl(items: LibraryItem[], candidateUrl: string): LibraryItem | undefined {
  const target = normalizeUrl(candidateUrl);
  return items.find((item) => {
    const itemUrl = isWebsite(item) ? item.url : (item as MediaItem).sourceUrl;
    return itemUrl ? normalizeUrl(itemUrl) === target : false;
  });
}

/** The same catalog-identity signal duplicate-detection.ts uses for "catalog_match" — provider + externalId, never title alone. */
function findItemByCatalogSource(items: LibraryItem[], provider: string, externalId: string): MediaItem | undefined {
  return items.find((item): item is MediaItem => item.type !== "website" && (item as MediaItem).catalogSource?.provider === provider && (item as MediaItem).catalogSource?.externalId === externalId);
}

interface ShareCaptureViewProps {
  sharedUrl?: string | null;
  sharedTitle?: string | null;
  sharedText?: string | null;
}

export function ShareCaptureView({ sharedUrl, sharedTitle, sharedText }: ShareCaptureViewProps) {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const userId = user?.id ?? null;
  const activity = useActivity(userId);
  const library = useLibraryItems([], activity.logEvent, userId);
  const localImport = useLocalImport(userId);
  const onboarding = useLibraryActivation({ loading: authLoading || !library.isHydrated, itemCount: library.items.length });

  const shareResult = useMemo(() => extractShareUrl({ url: sharedUrl, text: sharedText }), [sharedUrl, sharedText]);
  const candidateTitle = useMemo(() => extractShareTitle({ title: sharedTitle, text: sharedText }), [sharedTitle, sharedText]);
  const hasAnyPayload = Boolean(sharedUrl?.trim() || sharedTitle?.trim() || sharedText?.trim());

  // `step` is the user's own forward progress through the flow — once set,
  // it takes over from the data-derived starting point below (which must
  // stay a plain useMemo, not a lazy useState initializer, since library
  // hydration completing AFTER first render must still be reflected).
  const [step, setStep] = useState<Step | null>(null);
  const [pastedUrl, setPastedUrl] = useState("");
  const [pasteError, setPasteError] = useState<string | undefined>();
  const [resolvedPasteUrl, setResolvedPasteUrl] = useState<string | null>(null);
  const [linkSourceBusy, setLinkSourceBusy] = useState(false);
  const [linkSourceNotice, setLinkSourceNotice] = useState<string | undefined>();

  const effectiveUrl = resolvedPasteUrl ?? (shareResult.status === "valid" ? shareResult.url : null);

  const derivedStep: Step = useMemo(() => {
    if (resolvedPasteUrl) {
      const match = findItemByExactUrl(library.items, resolvedPasteUrl);
      return match ? { kind: "existing-item", item: match } : { kind: "review" };
    }
    if (!hasAnyPayload) return { kind: "no-payload" };
    if (shareResult.status === "invalid") return { kind: "invalid" };
    if (shareResult.status === "missing") return { kind: "missing" };
    const match = findItemByExactUrl(library.items, shareResult.url);
    return match ? { kind: "existing-item", item: match } : { kind: "review" };
  }, [resolvedPasteUrl, hasAnyPayload, shareResult, library.items]);

  const activationState = resolveActivationState({
    loading: authLoading || !library.isHydrated || !onboarding.isHydrated,
    loadError: Boolean(library.error),
    itemCount: library.items.length,
    pendingLocalImport: localImport.hasPendingImport,
    hasEverHadLibraryItems: onboarding.hasEverHadLibraryItems,
  });

  if (activationState === "loading") {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  if (activationState === "import-pending") {
    return (
      <div className="rounded-lg border border-border bg-surface p-4 sm:p-5">
        <h2 className="text-base font-semibold text-foreground">Finish importing your library first</h2>
        <p className="mt-1.5 text-sm text-muted-foreground">
          You have local library data waiting to be imported. Resolve that on the Dashboard before capturing a new link, so nothing gets mixed up.
        </p>
        <Button variant="primary" className="mt-3" onClick={() => router.push("/")}>
          Go to Dashboard
        </Button>
      </div>
    );
  }

  const activeStep = step ?? derivedStep;

  function handleCancel() {
    router.push("/library");
  }

  function handleSelectType(itemType: SupportedItemType) {
    setStep(itemType === "website" ? { kind: "form-website" } : { kind: "search", itemType });
  }

  function handleSelectSearchResult(itemType: SupportedItemType, details: MetadataDetails) {
    const match = findItemByCatalogSource(library.items, details.provider, details.externalId);
    setStep(match ? { kind: "existing-item", item: match } : { kind: "form-media", itemType, prefill: details });
  }

  function handleManualEntry(itemType: SupportedItemType) {
    const detected: DetectedPrefill | undefined = effectiveUrl || candidateTitle ? { title: candidateTitle, sourceUrl: effectiveUrl ?? undefined } : undefined;
    setStep({ kind: "form-media", itemType, detected });
  }

  function handleSubmitWebsite(values: WebsiteItemInput) {
    const item = library.addWebsite(values);
    router.push(`/library/${item.id}`);
  }

  function handleSubmitMedia(itemType: SupportedItemType, values: MediaItemInput) {
    const item = library.addMedia(itemType as MediaItem["type"], values);
    // Stage 40 §22 — item creation and source linking are never one atomic
    // step: the item is already safely created at this point regardless of
    // what happens next. If there's a shared URL worth offering as a
    // source, ask explicitly instead of attaching it silently or
    // navigating straight past the opportunity.
    if (effectiveUrl && userId) {
      setStep({ kind: "link-source-prompt", itemId: item.id, url: effectiveUrl });
      return;
    }
    router.push(`/library/${item.id}`);
  }

  /**
   * Stage 40 §22 — explicit-only: called from a real button click, never
   * automatically. On failure, the already-created LibraryItem is left
   * exactly as-is (never rolled back/deleted client-side) — the user can
   * still reach it and retry adding a source from its own detail page.
   */
  async function handleLinkSource(itemId: string, url: string) {
    setLinkSourceBusy(true);
    setLinkSourceNotice(undefined);
    try {
      const response = await fetch("/api/tracking-sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ libraryItemId: itemId, url }),
      });
      if (!response.ok) throw new Error("failed");
    } catch {
      // Non-blocking: the item already exists safely; report and let the
      // user retry from the item's own Sources section instead of getting
      // stuck on this confirmation screen.
      setLinkSourceNotice("Couldn't link that source. You can add it later from the item's Sources section.");
      setLinkSourceBusy(false);
      return;
    }
    router.push(`/library/${itemId}`);
  }

  function handlePasteContinue() {
    const result = extractShareUrl({ url: pastedUrl });
    if (result.status !== "valid") {
      setPasteError(result.status === "invalid" ? "This link can't be used. Markly accepts normal http and https links." : "Enter a web address, e.g. example.com/page");
      return;
    }
    setResolvedPasteUrl(result.url);
    const match = findItemByExactUrl(library.items, result.url);
    setStep(match ? { kind: "existing-item", item: match } : { kind: "review" });
  }

  if (activeStep.kind === "no-payload") {
    return (
      <div className="rounded-lg border border-border bg-surface p-4 sm:p-5">
        <h2 className="text-base font-semibold text-foreground">Capture a link</h2>
        <p className="mt-1.5 text-sm text-muted-foreground">Paste a link to start adding it to Markly.</p>
        <div className="mt-4">
          <Field label="Link" htmlFor="paste-url" error={pasteError}>
            <input
              id="paste-url"
              type="text"
              value={pastedUrl}
              onChange={(event) => {
                setPastedUrl(event.target.value);
                setPasteError(undefined);
              }}
              placeholder="e.g. example.com/page"
              className={inputClass(Boolean(pasteError))}
            />
          </Field>
        </div>
        <div className="mt-4 flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={handleCancel}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handlePasteContinue}>
            Continue
          </Button>
        </div>
      </div>
    );
  }

  if (activeStep.kind === "missing") {
    return (
      <div className="rounded-lg border border-border bg-surface p-4 sm:p-5">
        <h2 className="text-base font-semibold text-foreground">Add to Markly</h2>
        {candidateTitle && <p className="mt-2 truncate text-sm font-medium text-foreground">{candidateTitle}</p>}
        <p className="mt-1 text-sm text-muted-foreground">No link was included in this share.</p>
        <div className="mt-4 flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={handleCancel}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => setStep({ kind: "pickType" })}>
            Continue
          </Button>
        </div>
      </div>
    );
  }

  if (activeStep.kind === "invalid") {
    return (
      <div className="rounded-lg border border-border bg-surface p-4 sm:p-5">
        <h2 className="text-base font-semibold text-foreground">This link can&rsquo;t be used</h2>
        {candidateTitle && <p className="mt-2 truncate text-sm font-medium text-foreground">{candidateTitle}</p>}
        <p className="mt-1 text-sm text-muted-foreground">Markly accepts normal http and https links.</p>
        <div className="mt-4 flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={handleCancel}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => setStep({ kind: "pickType" })}>
            Continue
          </Button>
        </div>
      </div>
    );
  }

  if (activeStep.kind === "existing-item") {
    // Stage 40 §21 — the shared URL may be worth linking as a first-class,
    // manageable Source even though it already resolved to an existing
    // item (e.g. it matched via catalog identity, not this exact URL).
    // Website items have no Sources concept at all (Section 57 — a
    // website's own `url` already IS its one destination).
    const offerLinkSource = !isWebsite(activeStep.item) && Boolean(effectiveUrl) && Boolean(userId);
    return (
      <div className="rounded-lg border border-border bg-surface p-4 sm:p-5">
        <h2 className="text-base font-semibold text-foreground">You already have this</h2>
        <p className="mt-1.5 truncate text-sm text-muted-foreground">{activeStep.item.title}</p>
        {linkSourceNotice && <p className="mt-2 text-xs text-muted-foreground">{linkSourceNotice}</p>}
        <div className="mt-4 flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={handleCancel}>
            Cancel
          </Button>
          {offerLinkSource && (
            <Button
              variant="secondary"
              disabled={linkSourceBusy}
              onClick={() => effectiveUrl && handleLinkSource(activeStep.item.id, effectiveUrl)}
            >
              {linkSourceBusy ? "Linking…" : "Link this source"}
            </Button>
          )}
          <Button variant="primary" onClick={() => router.push(`/library/${activeStep.item.id}`)}>
            Open existing item
          </Button>
        </div>
      </div>
    );
  }

  if (activeStep.kind === "link-source-prompt") {
    return (
      <div className="rounded-lg border border-border bg-surface p-4 sm:p-5">
        <h2 className="text-base font-semibold text-foreground">Link this page as a source?</h2>
        <p className="mt-1.5 text-sm text-muted-foreground">You can always add or remove sources later from this item&rsquo;s page.</p>
        {linkSourceNotice && <p className="mt-2 text-xs text-muted-foreground">{linkSourceNotice}</p>}
        <div className="mt-4 flex items-center justify-end gap-2">
          <Button variant="secondary" disabled={linkSourceBusy} onClick={() => router.push(`/library/${activeStep.itemId}`)}>
            Skip
          </Button>
          <Button variant="primary" disabled={linkSourceBusy} onClick={() => handleLinkSource(activeStep.itemId, activeStep.url)}>
            {linkSourceBusy ? "Linking…" : "Link source"}
          </Button>
        </div>
      </div>
    );
  }

  if (activeStep.kind === "review") {
    const hostname = effectiveUrl ? getDomain(effectiveUrl) : null;
    return (
      <div className="rounded-lg border border-border bg-surface p-4 sm:p-5">
        <h2 className="text-base font-semibold text-foreground">Add to Markly</h2>
        {candidateTitle && <p className="mt-2 truncate text-sm font-medium text-foreground">{candidateTitle}</p>}
        {hostname && <p className="mt-1 text-sm text-muted-foreground">{hostname}</p>}
        {effectiveUrl && <p className="mt-0.5 truncate text-xs text-muted-foreground">{truncateForDisplay(effectiveUrl, 90)}</p>}
        <div className="mt-4 flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={handleCancel}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => setStep({ kind: "pickType" })}>
            Continue
          </Button>
        </div>
      </div>
    );
  }

  if (activeStep.kind === "pickType") {
    return <ItemTypePicker onSelect={handleSelectType} />;
  }

  if (activeStep.kind === "search") {
    return (
      <MetadataSearchPanel
        itemType={activeStep.itemType as MediaItem["type"]}
        initialQuery={candidateTitle || undefined}
        onSelect={(details) => handleSelectSearchResult(activeStep.itemType, details)}
        onManualEntry={() => handleManualEntry(activeStep.itemType)}
      />
    );
  }

  if (activeStep.kind === "form-website") {
    return (
      <WebsiteItemForm
        initialUrl={effectiveUrl ?? undefined}
        initialTitle={candidateTitle || undefined}
        existingCategories={getUniqueCategories(library.items)}
        onSubmit={handleSubmitWebsite}
        onCancel={handleCancel}
      />
    );
  }

  // form-media
  if (activeStep.prefill && !activeStep.showFullForm) {
    const mediaType = activeStep.itemType as MediaItem["type"];
    const prefill = activeStep.prefill;
    return (
      <CatalogTrackingForm
        type={mediaType}
        mode="add"
        display={buildCatalogDisplayFromPrefill(mediaType, prefill)}
        totalEpisodes={prefill.totalEpisodes}
        totalChapters={prefill.totalChapters}
        initial={{ status: "planned" }}
        onSubmit={(personal: PersonalTrackingValues) => handleSubmitMedia(activeStep.itemType, buildCatalogMediaInput(mediaType, prefill, personal))}
        onChangeSelection={() => setStep({ kind: "search", itemType: activeStep.itemType })}
        onEditFullDetails={() => setStep({ ...activeStep, showFullForm: true })}
        onCancel={handleCancel}
      />
    );
  }

  return (
    <MediaItemForm
      type={activeStep.itemType as MediaItem["type"]}
      prefill={activeStep.prefill}
      detected={activeStep.detected}
      existingCategories={getUniqueCategories(library.items)}
      onSubmit={(values) => handleSubmitMedia(activeStep.itemType, values)}
      onCancel={handleCancel}
    />
  );
}
