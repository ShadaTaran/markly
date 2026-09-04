"use client";

import { useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { getSupabaseClient } from "@/lib/supabase/client";
import { fetchLibraryItems, upsertLibraryItem } from "@/lib/cloud/library-items";
import { insertActivityEvent } from "@/lib/cloud/activity";
import { isMediaItem } from "@/lib/item-detail";
import { createMediaItem, getUniqueCategories, normalizeCategory } from "@/lib/library-items";
import { generateId } from "@/lib/utils";
import { ITEM_TYPE_LABELS } from "@/types/library-item";
import type { MediaItem, MediaItemInput } from "@/types/library-item";
import type { DeviceSummary } from "@/lib/extension/devices";
import type { TrackingSourceSummary } from "@/lib/extension/types";
import { buildDetectedMediaInput, buildDetectedTrackingValues } from "@/lib/extension/detected-item";
import { LibraryItemDialog, type DialogState } from "@/components/LibraryItemDialog";
import type { DetectedFallback } from "@/components/MetadataSearchPanel";
import { Dialog } from "@/components/Dialog";
import { MediaItemForm } from "@/components/MediaItemForm";
import type { PersonalTrackingValues } from "@/components/CatalogTrackingForm";
import type { MetadataDetails } from "@/lib/metadata/types";

interface TrackingSettingsPanelProps {
  initialDevices: DeviceSummary[];
  initialSources: TrackingSourceSummary[];
}

function formatRelative(iso: string | null): string {
  if (!iso) return "Never";
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function hostnameFromSourceUrl(sourceUrl: string | null): string {
  if (!sourceUrl) return "the detected page";
  try {
    return new URL(sourceUrl).hostname;
  } catch {
    return "the detected page";
  }
}

function progressLabel(progress: TrackingSourceSummary["lastDetectedProgress"]): string {
  if (!progress) return "—";
  if (progress.kind === "season_episode") {
    return progress.season !== undefined ? `Season ${progress.season}, Episode ${progress.value}` : `Episode ${progress.value}`;
  }
  if (progress.kind === "episode") return `Episode ${progress.value}`;
  if (progress.kind === "chapter") return `Chapter ${progress.value}`;
  if (progress.kind === "page") return `Page ${progress.value}`;
  if (progress.kind === "percent") return `${progress.value}%`;
  if (progress.kind === "playtime") return `${progress.value}h`;
  return `${progress.kind} ${progress.value}`;
}

export function TrackingSettingsPanel({ initialDevices, initialSources }: TrackingSettingsPanelProps) {
  const { user } = useAuth();
  const [devices, setDevices] = useState(initialDevices);
  const [sources, setSources] = useState(initialSources);
  const [pairingCode, setPairingCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [revokeConfirmId, setRevokeConfirmId] = useState<string | null>(null);
  const [linkingSourceId, setLinkingSourceId] = useState<string | null>(null);
  const [libraryItems, setLibraryItems] = useState<MediaItem[] | null>(null);
  const [itemFilter, setItemFilter] = useState("");
  const [addLinkSource, setAddLinkSource] = useState<TrackingSourceSummary | null>(null);
  const [addDialogState, setAddDialogState] = useState<DialogState>(null);
  const [editDetailsOpen, setEditDetailsOpen] = useState(false);

  async function generateCode() {
    setBusy("pairing-code");
    setError(undefined);
    try {
      const response = await fetch("/api/extension/pairing-code", { method: "POST" });
      const data = await response.json();
      if (!response.ok) {
        setError("Couldn't generate a pairing code. Try again.");
        return;
      }
      setPairingCode(data);
    } catch {
      setError("Couldn't generate a pairing code. Try again.");
    } finally {
      setBusy(null);
    }
  }

  async function revokeDevice(deviceId: string) {
    setBusy(`revoke-${deviceId}`);
    setError(undefined);
    try {
      const response = await fetch("/api/extension/devices/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId }),
      });
      if (!response.ok) {
        setError("Couldn't revoke that device. Try again.");
        return;
      }
      setDevices((current) => current.filter((device) => device.id !== deviceId));
      setRevokeConfirmId(null);
    } catch {
      setError("Couldn't revoke that device. Try again.");
    } finally {
      setBusy(null);
    }
  }

  /**
   * Stage 22 — the single place this preference is written; the extension
   * popup deliberately has no separate toggle/copy of it (see README
   * "Optional Zero-Touch Auto-Add"). Optimistic like the other device rows
   * here, reverted on failure.
   */
  async function toggleAutoAdd(deviceId: string, enabled: boolean) {
    setBusy(`auto-add-${deviceId}`);
    setError(undefined);
    setDevices((current) => current.map((device) => (device.id === deviceId ? { ...device, autoAddEnabled: enabled } : device)));
    try {
      const response = await fetch("/api/extension/devices/auto-add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId, enabled }),
      });
      if (!response.ok) throw new Error("failed");
    } catch {
      setDevices((current) => current.map((device) => (device.id === deviceId ? { ...device, autoAddEnabled: !enabled } : device)));
      setError("Couldn't update that setting. Try again.");
    } finally {
      setBusy(null);
    }
  }

  async function openLinkPicker(sourceId: string) {
    setLinkingSourceId(sourceId);
    setItemFilter("");
    if (libraryItems || !user) return;
    const supabase = getSupabaseClient();
    if (!supabase) return;
    try {
      const items = await fetchLibraryItems(supabase, user.id);
      setLibraryItems(items.filter(isMediaItem));
    } catch {
      setError("Couldn't load your library to link this source.");
    }
  }

  async function linkItem(sourceId: string, libraryItemId: string) {
    setBusy(`link-${sourceId}`);
    setError(undefined);
    try {
      const response = await fetch("/api/tracking-sources/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceId, libraryItemId }),
      });
      if (!response.ok) {
        setError("Couldn't link that item. Try again.");
        return;
      }
      setSources((current) => current.map((source) => (source.id === sourceId ? { ...source, libraryItemId } : source)));
      setLinkingSourceId(null);
    } catch {
      setError("Couldn't link that item. Try again.");
    } finally {
      setBusy(null);
    }
  }

  /**
   * Creates a new LibraryItem and links the given source to it — the one
   * shared path behind all three ways "Add or Link" can end in a brand-new
   * item (a selected catalog result, the one-click detected-work
   * fallback, or a reviewed/edited version of it). The create is awaited
   * (unlike the optimistic-local-then-fire-and-forget pattern
   * `useLibraryItems` uses elsewhere) specifically so the row genuinely
   * exists in the database before the link request runs — the
   * `tracking_sources` RLS policy re-verifies the target item belongs to
   * this user at link time, and linking against a not-yet-persisted item
   * would be a real (if narrow) race, not just a cosmetic one. Only one
   * `item_added` Activity event is recorded — the initial progress this
   * item is created with is not itself a "transition" (there's no prior
   * value to diff against), so no progress_updated event is generated for
   * it, matching how a plain "Add Item" never logs one either.
   */
  async function createAndLinkItem(source: TrackingSourceSummary, itemType: MediaItem["type"], values: MediaItemInput) {
    if (!user) return;
    const supabase = getSupabaseClient();
    if (!supabase) return;

    setBusy(`add-link-${source.id}`);
    setError(undefined);
    try {
      const normalized = { ...values, category: normalizeCategory(values.category, getUniqueCategories(libraryItems ?? [])) };
      const newItem = createMediaItem(itemType, generateId(), new Date().toISOString(), normalized);

      await upsertLibraryItem(supabase, newItem, user.id);
      insertActivityEvent(
        supabase,
        { id: generateId(), type: "item_added", itemId: newItem.id, timestamp: new Date().toISOString() },
        user.id,
      ).catch(() => undefined);
      setLibraryItems((current) => (current ? [newItem, ...current] : current));

      setBusy(null);
      await linkItem(source.id, newItem.id); // has its own busy/error handling
    } catch {
      setError("Couldn't add that item. Try again.");
      setBusy(null);
    }
  }

  /**
   * "Add or Link" search-and-create — reuses the same catalog search and
   * Add Item form the main library uses (LibraryItemDialog), pre-seeded
   * with this source's detected title and media type, so a source with no
   * existing library match can be added and linked in one flow instead of
   * requiring a trip to the library page first. Selecting an existing
   * library item stays exactly as before (the inline picker above), left
   * untouched.
   */
  function openAddLinkDialog(source: TrackingSourceSummary) {
    setAddLinkSource(source);
    setAddDialogState({ step: "search", mode: "add", itemType: source.mediaType, initialQuery: source.sourceTitle });
  }

  function handleAddDialogSelectSearchResult(details: MetadataDetails) {
    if (addDialogState?.step !== "search") return;
    setAddDialogState({ step: "form", mode: "add", itemType: addDialogState.itemType, prefill: details });
  }

  function handleAddDialogManualEntry() {
    if (addDialogState?.step !== "search") return;
    setAddDialogState({ step: "form", mode: "add", itemType: addDialogState.itemType });
  }

  function handleAddDialogBackToSearch() {
    if (addDialogState?.step !== "form" || addDialogState.mode !== "add" || addDialogState.itemType === "website") return;
    setAddDialogState({ step: "search", mode: "add", itemType: addDialogState.itemType, initialQuery: addLinkSource?.sourceTitle });
  }

  function handleAddDialogBackToPicker() {
    // This flow never has a type-picker step (the type is always the
    // detected source's mediaType) — "back" from the search step closes
    // the dialog outright instead.
    handleCloseAddDialog();
  }

  function handleAddDialogToggleFullForm() {
    if (addDialogState?.step !== "form") return;
    setAddDialogState({ ...addDialogState, showFullForm: true });
  }

  function handleCloseAddDialog() {
    setAddDialogState(null);
    setAddLinkSource(null);
  }

  async function handleAddDialogSubmitMedia(values: MediaItemInput) {
    if (addDialogState?.step !== "form" || addDialogState.itemType === "website" || !addLinkSource) return;
    const source = addLinkSource;
    const itemType = addDialogState.itemType;
    setAddDialogState(null);
    setAddLinkSource(null);
    await createAndLinkItem(source, itemType, values);
  }

  /**
   * The one-click path from the "No catalog results — add detected work"
   * offer (see MetadataSearchPanel's detectedFallback). No form, no
   * retyping — title/progress/media type all come straight from what the
   * extension already detected (lib/extension/detected-item.ts).
   */
  async function handleAddDetectedWork() {
    if (!addLinkSource || busy !== null) return;
    const source = addLinkSource;
    setAddDialogState(null);
    setAddLinkSource(null);
    await createAndLinkItem(source, source.mediaType, buildDetectedMediaInput(source));
  }

  /** "Edit Details" from the same offer — same detected data, but reviewable/editable before saving, via the full MediaItemForm. */
  function openEditDetails() {
    if (!addLinkSource) return;
    setAddDialogState(null);
    setEditDetailsOpen(true);
  }

  function handleCloseEditDetails() {
    setEditDetailsOpen(false);
    setAddLinkSource(null);
  }

  async function handleEditDetailsSubmit(values: MediaItemInput) {
    if (!addLinkSource) return;
    const source = addLinkSource;
    setEditDetailsOpen(false);
    setAddLinkSource(null);
    await createAndLinkItem(source, source.mediaType, values);
  }

  async function unlinkSource(sourceId: string) {
    setBusy(`unlink-${sourceId}`);
    setError(undefined);
    try {
      const response = await fetch("/api/tracking-sources/unlink", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceId }),
      });
      if (!response.ok) {
        setError("Couldn't unlink that source. Try again.");
        return;
      }
      setSources((current) => current.map((source) => (source.id === sourceId ? { ...source, libraryItemId: null } : source)));
    } catch {
      setError("Couldn't unlink that source. Try again.");
    } finally {
      setBusy(null);
    }
  }

  // Offered on the catalog-search step whenever it comes up empty/errors
  // — external metadata is optional, not required, for tracking to work
  // (see README "Add or Link"). Derived from addLinkSource (not per-row)
  // since the dialog it feeds is itself a single shared instance driven
  // by whichever source is currently active.
  const detectedFallback: DetectedFallback | undefined = addLinkSource
    ? {
        title: addLinkSource.sourceTitle,
        sourceLabel: hostnameFromSourceUrl(addLinkSource.sourceUrl),
        progressLabel: addLinkSource.lastDetectedProgress ? progressLabel(addLinkSource.lastDetectedProgress) : undefined,
        coverUrl: addLinkSource.lastDetectedMetadata?.coverUrl,
        onAddAndTrack: handleAddDetectedWork,
        onEditDetails: openEditDetails,
        busy: busy === `add-link-${addLinkSource.id}`,
      }
    : undefined;

  // Seeds the catalog-hit compact review form with the detected progress
  // instead of leaving it blank — CatalogTrackingForm's own add-mode
  // status inference (planned vs. in_progress) already keys off whether
  // progress is actually filled in, so prefilling this is what makes Test
  // A's "progress = 40, status in_progress" happen automatically; nothing
  // else needs to force the status.
  const initialTrackingForAdd: PersonalTrackingValues | undefined = addLinkSource
    ? { status: "in_progress", ...buildDetectedTrackingValues(addLinkSource.mediaType, addLinkSource.lastDetectedProgress) }
    : undefined;

  return (
    <div className="space-y-6">
      {error && <p className="text-sm text-danger">{error}</p>}

      <section className="rounded-lg border border-border bg-surface p-4 sm:p-5">
        <h2 className="text-sm font-semibold text-foreground">Browser Extension</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Connect the Markly browser extension to automatically track your progress on supported reading pages.
        </p>

        {pairingCode ? (
          <div className="mt-3 rounded-md border border-border p-3">
            <p className="text-xs text-muted-foreground">Enter this code in the extension popup:</p>
            <p className="mt-1 font-mono text-lg tracking-wide text-foreground">{pairingCode.code}</p>
            <p className="mt-1 text-xs text-muted-foreground">Expires in about 10 minutes.</p>
          </div>
        ) : (
          <button
            type="button"
            onClick={generateCode}
            disabled={busy !== null}
            className="mt-3 rounded-md bg-foreground px-3.5 py-2 text-sm font-medium text-background transition-colors hover:bg-foreground/85 disabled:opacity-60"
          >
            {busy === "pairing-code" ? "Generating…" : "Connect Extension"}
          </button>
        )}

        {devices.length > 0 && (
          <div className="mt-4">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground/70">Connected Devices</h3>
            <ul className="mt-2 space-y-2">
              {devices.map((device) => (
                <li key={device.id} className="space-y-3 rounded-md border border-border p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm text-foreground">{device.name}</p>
                      <p className="text-xs text-muted-foreground">Last active: {formatRelative(device.lastSeenAt)}</p>
                    </div>
                    {revokeConfirmId === device.id ? (
                      <div className="flex shrink-0 items-center gap-2">
                        <button
                          type="button"
                          onClick={() => revokeDevice(device.id)}
                          disabled={busy !== null}
                          className="rounded-md border border-danger/40 px-2.5 py-1 text-xs font-medium text-danger transition-colors hover:bg-danger/10 disabled:opacity-60"
                        >
                          {busy === `revoke-${device.id}` ? "Revoking…" : "Confirm"}
                        </button>
                        <button
                          type="button"
                          onClick={() => setRevokeConfirmId(null)}
                          className="rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setRevokeConfirmId(device.id)}
                        disabled={busy !== null}
                        className="shrink-0 rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground disabled:opacity-60"
                      >
                        Revoke
                      </button>
                    )}
                  </div>

                  <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
                    <div>
                      <p className="text-xs font-medium text-foreground">Automatically add new works</p>
                      <p className="text-xs text-muted-foreground">
                        When Markly confidently detects something you&apos;re reading that isn&apos;t already in your library,
                        add it and start tracking automatically.
                      </p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={device.autoAddEnabled}
                      aria-label="Automatically add new works"
                      onClick={() => toggleAutoAdd(device.id, !device.autoAddEnabled)}
                      disabled={busy !== null}
                      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-60 ${
                        device.autoAddEnabled ? "bg-accent" : "bg-border"
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-background transition-transform ${
                          device.autoAddEnabled ? "translate-x-4" : "translate-x-0"
                        }`}
                      />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className="rounded-lg border border-border bg-surface p-4 sm:p-5">
        <h2 className="text-sm font-semibold text-foreground">Tracked Sources</h2>
        {sources.length === 0 ? (
          <p className="mt-1 text-sm text-muted-foreground">
            Nothing detected yet. Sources appear here once the extension sees a supported page.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {sources.map((source) => {
              const linkedItem = source.libraryItemId ? libraryItems?.find((item) => item.id === source.libraryItemId) : undefined;
              const compatibleItems = (libraryItems ?? []).filter((item) => item.type === source.mediaType);
              const filteredItems = compatibleItems.filter((item) => item.title.toLowerCase().includes(itemFilter.toLowerCase()));

              return (
                <li key={source.id} className="rounded-md border border-border p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-foreground">{source.sourceTitle}</p>
                      <p className="text-xs text-muted-foreground">
                        {ITEM_TYPE_LABELS[source.mediaType]} · {progressLabel(source.lastDetectedProgress)} · Seen {formatRelative(source.lastSeenAt)}
                      </p>
                    </div>
                  </div>

                  {source.libraryItemId ? (
                    <div className="mt-2 flex items-center justify-between gap-3">
                      <p className="text-sm text-muted-foreground">
                        Linked to: <span className="text-foreground">{linkedItem?.title ?? "Markly item"}</span>
                        <span className="ml-2 text-xs">Auto tracking: {source.autoTrackEnabled ? "On" : "Off"}</span>
                      </p>
                      <button
                        type="button"
                        onClick={() => unlinkSource(source.id)}
                        disabled={busy !== null}
                        className="shrink-0 rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground disabled:opacity-60"
                      >
                        {busy === `unlink-${source.id}` ? "Unlinking…" : "Unlink"}
                      </button>
                    </div>
                  ) : linkingSourceId === source.id ? (
                    <div className="mt-2 space-y-2">
                      <input
                        type="text"
                        value={itemFilter}
                        onChange={(event) => setItemFilter(event.target.value)}
                        placeholder={`Search your ${ITEM_TYPE_LABELS[source.mediaType]} items…`}
                        className="w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-sm text-foreground outline-none focus:border-accent focus:ring-2 focus:ring-accent/25"
                      />
                      {libraryItems === null ? (
                        <p className="text-xs text-muted-foreground">Loading your library…</p>
                      ) : filteredItems.length === 0 ? (
                        <p className="text-xs text-muted-foreground">No matching {ITEM_TYPE_LABELS[source.mediaType]} items.</p>
                      ) : (
                        <ul className="max-h-48 space-y-1 overflow-y-auto">
                          {filteredItems.map((item) => (
                            <li key={item.id}>
                              <button
                                type="button"
                                onClick={() => linkItem(source.id, item.id)}
                                disabled={busy !== null}
                                className="w-full rounded-md px-2.5 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-surface-hover disabled:opacity-60"
                              >
                                {item.title}
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                      <div className="flex items-center justify-between gap-3">
                        <button
                          type="button"
                          onClick={() => openAddLinkDialog(source)}
                          className="text-xs font-medium text-accent hover:underline"
                        >
                          Not in the list? Search the catalog to add it
                        </button>
                        <button
                          type="button"
                          onClick={() => setLinkingSourceId(null)}
                          className="shrink-0 text-xs font-medium text-muted-foreground hover:text-foreground"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-2 flex items-center justify-between gap-3">
                      <p className="text-xs text-muted-foreground">Not linked</p>
                      <button
                        type="button"
                        onClick={() => openLinkPicker(source.id)}
                        className="shrink-0 rounded-md bg-foreground px-2.5 py-1 text-xs font-medium text-background transition-colors hover:bg-foreground/85"
                      >
                        Add or Link
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <LibraryItemDialog
        state={addDialogState}
        existingCategories={getUniqueCategories(libraryItems ?? [])}
        onSelectType={() => undefined}
        onSelectSearchResult={handleAddDialogSelectSearchResult}
        onManualEntry={handleAddDialogManualEntry}
        onBackToPicker={handleAddDialogBackToPicker}
        onBackToSearch={handleAddDialogBackToSearch}
        onToggleFullForm={handleAddDialogToggleFullForm}
        onClose={handleCloseAddDialog}
        onSubmitWebsite={() => undefined}
        onSubmitMedia={handleAddDialogSubmitMedia}
        detectedFallback={detectedFallback}
        initialTrackingForAdd={initialTrackingForAdd}
      />

      <Dialog
        isOpen={editDetailsOpen && addLinkSource !== null}
        onClose={handleCloseEditDetails}
        title={`Add ${addLinkSource ? ITEM_TYPE_LABELS[addLinkSource.mediaType] : "Item"}`}
      >
        {addLinkSource && (
          <MediaItemForm
            key={addLinkSource.id}
            type={addLinkSource.mediaType}
            detected={{
              title: addLinkSource.sourceTitle,
              sourceUrl: addLinkSource.lastDetectedMetadata?.workUrl ?? addLinkSource.sourceUrl ?? undefined,
              readingFormat: addLinkSource.mediaType === "novel" ? "web_novel" : undefined,
              status: "in_progress",
              imageUrl: addLinkSource.lastDetectedMetadata?.coverUrl,
              description: addLinkSource.lastDetectedMetadata?.description,
              authors: addLinkSource.lastDetectedMetadata?.authors,
              genres: addLinkSource.lastDetectedMetadata?.genres,
              ...buildDetectedTrackingValues(addLinkSource.mediaType, addLinkSource.lastDetectedProgress),
            }}
            existingCategories={getUniqueCategories(libraryItems ?? [])}
            onSubmit={handleEditDetailsSubmit}
            onCancel={handleCloseEditDetails}
          />
        )}
      </Dialog>
    </div>
  );
}
