"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { getSupabaseClient } from "@/lib/supabase/client";
import { fetchLibraryItems, upsertLibraryItem } from "@/lib/cloud/library-items";
import { insertActivityEvent } from "@/lib/cloud/activity";
import { isMediaItem } from "@/lib/item-detail";
import { createMediaItem, getUniqueCategories, normalizeCategory } from "@/lib/library-items";
import { generateId } from "@/lib/utils";
import { formatRelativeTime } from "@/lib/activity-format";
import { ITEM_TYPE_LABELS } from "@/types/library-item";
import type { MediaItem, MediaItemInput } from "@/types/library-item";
import type { DeviceSummary } from "@/lib/extension/devices";
import type { TrackingSourceSummary } from "@/lib/extension/types";
import { buildDetectedMediaInput, buildDetectedTrackingValues } from "@/lib/extension/detected-item";
import { getSafeOpenSourceUrl, getSourceDisplayName, getSourceHostname, formatSourceProgress } from "@/lib/extension/source-display";
import { LibraryItemDialog, type DialogState } from "@/components/LibraryItemDialog";
import type { DetectedFallback } from "@/components/MetadataSearchPanel";
import { Dialog } from "@/components/Dialog";
import { MediaItemForm } from "@/components/MediaItemForm";
import type { PersonalTrackingValues } from "@/components/CatalogTrackingForm";
import type { MetadataDetails } from "@/lib/metadata/types";
import { ExternalLinkIcon, MoreHorizontalIcon } from "@/components/icons";
import { Button } from "@/components/Button";
import { Switch } from "@/components/Switch";
import { IconButton } from "@/components/IconButton";

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

/** Stage 26 — a group of tracking sources that all point at the same LibraryItem (see README "Cross-Source Work Identity"). */
interface SourceGroup {
  itemId: string;
  itemTitle: string;
  sources: TrackingSourceSummary[];
}

function groupLinkedSources(sources: TrackingSourceSummary[], libraryItems: MediaItem[] | null): SourceGroup[] {
  const groups = new Map<string, SourceGroup>();
  for (const source of sources) {
    if (!source.libraryItemId) continue;
    const itemId = source.libraryItemId;
    const existing = groups.get(itemId);
    if (existing) {
      existing.sources.push(source);
      continue;
    }
    const itemTitle = libraryItems?.find((item) => item.id === itemId)?.title ?? "Markly item";
    groups.set(itemId, { itemId, itemTitle, sources: [source] });
  }
  return Array.from(groups.values()).sort((a, b) => a.itemTitle.localeCompare(b.itemTitle, undefined, { sensitivity: "base" }));
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
  const [showAllDevices, setShowAllDevices] = useState(false);

  // Stage 26 — loaded eagerly (rather than only on first "Add or Link"
  // click, as before) so linked sources can be grouped under their real
  // LibraryItem title immediately, without a "Markly item" placeholder
  // flashing first. A ref (not `libraryItems` state) guards against
  // re-fetching, so this effect's own dependency list stays exhaustive
  // with no suppression needed. openLinkPicker's own fetch below still
  // runs — it's a no-op once this wins the race (same ref guard), and a
  // fallback if a user clicks before this resolves.
  const libraryItemsFetchStarted = useRef(false);
  useEffect(() => {
    const userId = user?.id;
    if (!userId || libraryItemsFetchStarted.current) return;
    libraryItemsFetchStarted.current = true;
    const supabase = getSupabaseClient();
    if (!supabase) return;
    fetchLibraryItems(supabase, userId)
      .then((items) => setLibraryItems(items.filter(isMediaItem)))
      .catch(() => setError("Couldn't load your library."));
  }, [user?.id]);

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
    if (libraryItemsFetchStarted.current || !user) return;
    libraryItemsFetchStarted.current = true;
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
      setSources((current) =>
        current.map((source) => (source.id === sourceId ? { ...source, libraryItemId, autoLinkSuppressed: false } : source)),
      );
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
      setSources((current) =>
        current.map((source) => (source.id === sourceId ? { ...source, libraryItemId: null, autoLinkSuppressed: true } : source)),
      );
    } catch {
      setError("Couldn't unlink that source. Try again.");
    } finally {
      setBusy(null);
    }
  }

  /** Stage 26 — the auto_track_enabled toggle already existed server-side (Stage 18/22); this is the first UI that lets a user actually flip it. */
  async function toggleAutoTrack(sourceId: string, enabled: boolean) {
    setBusy(`toggle-${sourceId}`);
    setError(undefined);
    setSources((current) => current.map((source) => (source.id === sourceId ? { ...source, autoTrackEnabled: enabled } : source)));
    try {
      const response = await fetch("/api/tracking-sources/toggle-auto-track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceId, enabled }),
      });
      if (!response.ok) throw new Error("failed");
    } catch {
      setSources((current) => current.map((source) => (source.id === sourceId ? { ...source, autoTrackEnabled: !enabled } : source)));
      setError("Couldn't update that setting. Try again.");
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
        sourceLabel: getSourceDisplayName(addLinkSource.adapterId, addLinkSource.sourceUrl, addLinkSource.sourceTitle),
        progressLabel: addLinkSource.lastDetectedProgress ? formatSourceProgress(addLinkSource.lastDetectedProgress) : undefined,
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

  // Stage 26 — linked sources are grouped under the one LibraryItem they
  // all point at (see README "Cross-Source Work Identity"); unlinked ones
  // keep the existing flat "needs attention" flow unchanged (Section 24 of
  // the Stage 26 spec — that flow must remain exactly as it was).
  const linkedGroups = groupLinkedSources(sources, libraryItems);
  const unlinkedSources = sources.filter((source) => !source.libraryItemId);

  const DEVICE_PREVIEW_LIMIT = 4;
  const sortedDevices = [...devices].sort((a, b) => (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? ""));
  const recentDevices = sortedDevices.slice(0, DEVICE_PREVIEW_LIMIT);
  const olderDevices = sortedDevices.slice(DEVICE_PREVIEW_LIMIT);

  return (
    <div className="space-y-6">
      {error && <p className="text-sm text-danger">{error}</p>}

      <section className="rounded-lg border border-border bg-surface p-4 sm:p-5">
        <h2 className="text-base font-semibold text-foreground">Browser Extension</h2>
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
          <Button variant="primary" onClick={generateCode} disabled={busy !== null} className="mt-3 min-w-40">
            {busy === "pairing-code" ? "Generating…" : "Connect Extension"}
          </Button>
        )}

        {devices.length > 0 && (
          <div className="mt-4 border-t border-border pt-4">
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground/70">
              Connected Devices · {devices.length}
            </h3>
            <p className="mb-3 text-xs text-muted-foreground">
              Auto-add automatically adds and starts tracking new works Markly confidently detects, per device.
            </p>

            <ul className="divide-y divide-border rounded-md border border-border">
              {recentDevices.map((device) => (
                <DeviceRow
                  key={device.id}
                  device={device}
                  busy={busy}
                  revokeConfirmId={revokeConfirmId}
                  onToggleAutoAdd={toggleAutoAdd}
                  onRequestRevoke={setRevokeConfirmId}
                  onRevoke={revokeDevice}
                />
              ))}
            </ul>

            {olderDevices.length > 0 && (
              <div className="mt-4">
                <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
                  Older Devices · {olderDevices.length}
                </p>
                {showAllDevices ? (
                  <ul className="divide-y divide-border rounded-md border border-border">
                    {olderDevices.map((device) => (
                      <DeviceRow
                        key={device.id}
                        device={device}
                        busy={busy}
                        revokeConfirmId={revokeConfirmId}
                        onToggleAutoAdd={toggleAutoAdd}
                        onRequestRevoke={setRevokeConfirmId}
                        onRevoke={revokeDevice}
                      />
                    ))}
                  </ul>
                ) : (
                  <button
                    type="button"
                    onClick={() => setShowAllDevices(true)}
                    className="text-xs font-medium text-muted-foreground hover:text-foreground hover:underline"
                  >
                    Show older devices
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-1 text-base font-semibold text-foreground">Tracked Sources</h2>
        {sources.length === 0 ? (
          <p className="mt-1 text-sm text-muted-foreground">
            Nothing detected yet. Sources appear here once the extension sees a supported page.
          </p>
        ) : (
          <div className="mt-3 space-y-5">
            {linkedGroups.length > 0 && (
              <div className="space-y-3">
                <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground/70">
                  Linked · {linkedGroups.reduce((total, group) => total + group.sources.length, 0)}
                </h3>
                {linkedGroups.map((group) => (
                  <div key={group.itemId}>
                    <div className="mb-1.5 flex items-baseline justify-between gap-3">
                      <p className="text-sm font-medium text-foreground">{group.itemTitle}</p>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {group.sources.length} source{group.sources.length === 1 ? "" : "s"}
                      </span>
                    </div>
                    <ul className="divide-y divide-border rounded-md border border-border">
                      {group.sources.map((source) => {
                        const hostname = getSourceHostname(source.sourceUrl);
                        const openUrl = getSafeOpenSourceUrl(source);
                        return (
                          <li key={source.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 px-3 py-2.5">
                            <div className="min-w-0">
                              <p className="truncate text-sm text-foreground">
                                {getSourceDisplayName(source.adapterId, source.sourceUrl, source.sourceTitle)}
                                {hostname && <span className="text-muted-foreground"> · {hostname}</span>}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {formatSourceProgress(source.lastDetectedProgress)} · Seen {formatRelativeTime(source.lastSeenAt)} · Auto
                                Tracking: {source.autoTrackEnabled ? "On" : "Off"}
                              </p>
                            </div>
                            <div className="flex shrink-0 flex-wrap items-center gap-2">
                              {openUrl && (
                                <a
                                  href={openUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="flex items-center gap-1 text-xs font-medium text-accent hover:underline"
                                >
                                  <ExternalLinkIcon width={12} height={12} />
                                  Open Source
                                </a>
                              )}
                              <SourceActionsMenu
                                label={getSourceDisplayName(source.adapterId, source.sourceUrl, source.sourceTitle)}
                                autoTrackEnabled={source.autoTrackEnabled}
                                busy={busy === `toggle-${source.id}` || busy === `unlink-${source.id}`}
                                onToggleAutoTrack={() => toggleAutoTrack(source.id, !source.autoTrackEnabled)}
                                onUnlink={() => unlinkSource(source.id)}
                              />
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
              </div>
            )}

            {unlinkedSources.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground/70">
                  Unlinked · {unlinkedSources.length}
                </h3>
                <ul className="divide-y divide-border rounded-md border border-border">
                  {unlinkedSources.map((source) => {
                    const compatibleItems = (libraryItems ?? []).filter((item) => item.type === source.mediaType);
                    const filteredItems = compatibleItems.filter((item) => item.title.toLowerCase().includes(itemFilter.toLowerCase()));

                    return (
                      <li key={source.id} className="px-3 py-2.5">
                        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
                          <div className="min-w-0">
                            <p className="truncate text-sm text-foreground">{source.sourceTitle}</p>
                            <p className="text-xs text-muted-foreground">
                              {/* sourceTitle is already the primary text above — omit it here (2-arg call) so the adapter/hostname label doesn't just repeat it */}
                              {getSourceDisplayName(source.adapterId, source.sourceUrl)} · {ITEM_TYPE_LABELS[source.mediaType]} ·{" "}
                              {formatSourceProgress(source.lastDetectedProgress)} · Seen {formatRelativeTime(source.lastSeenAt)}
                            </p>
                          </div>
                          {linkingSourceId !== source.id && (
                            <button
                              type="button"
                              onClick={() => openLinkPicker(source.id)}
                              className="shrink-0 rounded-md bg-foreground px-2.5 py-1 text-xs font-medium text-background transition-colors hover:bg-foreground/85"
                            >
                              Add or Link
                            </button>
                          )}
                        </div>

                        {linkingSourceId === source.id && (
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
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </div>
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

interface DeviceRowProps {
  device: DeviceSummary;
  busy: string | null;
  revokeConfirmId: string | null;
  onToggleAutoAdd: (deviceId: string, enabled: boolean) => void;
  onRequestRevoke: (deviceId: string | null) => void;
  onRevoke: (deviceId: string) => void;
}

function DeviceRow({ device, busy, revokeConfirmId, onToggleAutoAdd, onRequestRevoke, onRevoke }: DeviceRowProps) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-3 py-2.5">
      <div className="min-w-0">
        <p className="truncate text-sm text-foreground">{device.name}</p>
        <p className="text-xs text-muted-foreground">Last active {formatRelative(device.lastSeenAt)}</p>
      </div>
      <div className="flex shrink-0 items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Auto-add</span>
          <Switch
            checked={device.autoAddEnabled}
            onChange={(enabled) => onToggleAutoAdd(device.id, enabled)}
            disabled={busy !== null}
            aria-label={`Auto-add for ${device.name}`}
          />
        </div>
        {revokeConfirmId === device.id ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onRevoke(device.id)}
              disabled={busy !== null}
              className="rounded-md border border-danger/40 px-2 py-1 text-xs font-medium text-danger transition-colors hover:bg-danger/10 disabled:opacity-60"
            >
              {busy === `revoke-${device.id}` ? "Revoking…" : "Confirm"}
            </button>
            <button
              type="button"
              onClick={() => onRequestRevoke(null)}
              className="rounded-md px-1.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => onRequestRevoke(device.id)}
            disabled={busy !== null}
            className="rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground disabled:opacity-60"
          >
            Revoke
          </button>
        )}
      </div>
    </li>
  );
}

interface SourceActionsMenuProps {
  /** Used to build the trigger's accessible name: `More actions for ${label}`. */
  label: string;
  autoTrackEnabled: boolean;
  busy: boolean;
  onToggleAutoTrack: () => void;
  onUnlink: () => void;
}

/**
 * Round 4 — a linked source row previously showed Open Source, Disable/
 * Enable, and Unlink all inline (three competing actions of unclear
 * relative importance). Open Source stays inline as the one primary
 * action; the two maintenance actions move behind this small overflow
 * menu, visually matching ItemActionsMenu's pattern without changing that
 * shared component's fixed Edit/Delete contract (used elsewhere by
 * CollectionHeader and Item Detail).
 */
function SourceActionsMenu({ label, autoTrackEnabled, busy, onToggleAutoTrack, onUnlink }: SourceActionsMenuProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;

    function handlePointerDown(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setMenuOpen(false);
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen]);

  return (
    <div className="relative shrink-0" ref={menuRef}>
      <IconButton
        onClick={() => setMenuOpen((open) => !open)}
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={`More actions for ${label}`}
        icon={<MoreHorizontalIcon width={16} height={16} />}
      />

      {menuOpen && (
        <div role="menu" className="absolute right-0 top-full z-10 mt-1 w-44 overflow-hidden rounded-md border border-border bg-surface py-1 shadow-sm">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              onToggleAutoTrack();
            }}
            className="flex w-full items-center px-3 py-1.5 text-left text-sm text-foreground hover:bg-surface-hover"
          >
            {autoTrackEnabled ? "Disable tracking" : "Enable tracking"}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              onUnlink();
            }}
            className="flex w-full items-center px-3 py-1.5 text-left text-sm text-danger hover:bg-surface-hover"
          >
            Unlink
          </button>
        </div>
      )}
    </div>
  );
}
