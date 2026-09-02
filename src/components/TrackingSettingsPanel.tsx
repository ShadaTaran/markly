"use client";

import { useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { getSupabaseClient } from "@/lib/supabase/client";
import { fetchLibraryItems } from "@/lib/cloud/library-items";
import { isMediaItem } from "@/lib/item-detail";
import { ITEM_TYPE_LABELS } from "@/types/library-item";
import type { MediaItem } from "@/types/library-item";
import type { DeviceSummary } from "@/lib/extension/devices";
import type { TrackingSourceSummary } from "@/lib/extension/types";

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

function progressLabel(progress: TrackingSourceSummary["lastDetectedProgress"]): string {
  if (!progress) return "—";
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
                <li key={device.id} className="flex items-center justify-between gap-3 rounded-md border border-border p-3">
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
                      <button
                        type="button"
                        onClick={() => setLinkingSourceId(null)}
                        className="text-xs font-medium text-muted-foreground hover:text-foreground"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <div className="mt-2 flex items-center justify-between gap-3">
                      <p className="text-xs text-muted-foreground">Not linked</p>
                      <button
                        type="button"
                        onClick={() => openLinkPicker(source.id)}
                        className="shrink-0 rounded-md bg-foreground px-2.5 py-1 text-xs font-medium text-background transition-colors hover:bg-foreground/85"
                      >
                        Link Item
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
