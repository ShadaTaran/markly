"use client";

import { useEffect, useState } from "react";
import type { ConnectionSummary } from "@/lib/integrations/types";
import { AniListReconcilePanel } from "@/components/AniListReconcilePanel";
import { Button } from "@/components/Button";
import { Switch } from "@/components/Switch";

interface ConnectionsPanelProps {
  initialSummary: ConnectionSummary;
  justConnected: boolean;
  connectError?: string;
  /** Stage 30 — default OFF (§3/§16); undefined only if the connection couldn't be read at all, treated the same as false. */
  initialAllowWrites?: boolean;
}

interface PreviewData {
  username: string;
  anime: number;
  manga: number;
}

const CONNECT_ERROR_MESSAGES: Record<string, string> = {
  not_configured: "AniList isn't configured for this deployment yet.",
  denied: "AniList authorization was declined.",
  state_mismatch: "That AniList sign-in link expired or was already used. Try connecting again.",
  token_exchange_failed: "AniList could not be reached to finish connecting. Nothing was changed.",
  viewer_lookup_failed: "AniList could not confirm your account. Nothing was changed.",
  save_failed: "Your AniList connection couldn't be saved. Try again.",
};

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

export function ConnectionsPanel({ initialSummary, justConnected, connectError, initialAllowWrites }: ConnectionsPanelProps) {
  const [summary, setSummary] = useState(initialSummary);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [selection, setSelection] = useState({ anime: true, manga: true });
  const [busy, setBusy] = useState<"preview" | "import" | "disconnect" | "writePref" | null>(null);
  const [error, setError] = useState<string | undefined>(connectError ? CONNECT_ERROR_MESSAGES[connectError] ?? "Something went wrong connecting AniList." : undefined);
  const [disconnectConfirm, setDisconnectConfirm] = useState(false);
  const [allowWrites, setAllowWrites] = useState(initialAllowWrites ?? false);
  const [showEnableWritesConfirm, setShowEnableWritesConfirm] = useState(false);
  const [showReconcile, setShowReconcile] = useState(false);

  const isFirstImport = summary.connected && !summary.reconnectRequired && summary.lastSyncedAt === null;

  useEffect(() => {
    if (justConnected && isFirstImport && !preview && busy === null) {
      void runPreview();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once on mount to auto-preview right after a fresh connect; re-running on every state change would refetch on unrelated updates.
  }, []);

  async function runPreview() {
    setBusy("preview");
    setError(undefined);
    try {
      const response = await fetch("/api/integrations/anilist/preview");
      const data = await response.json();
      if (!response.ok) {
        setError(errorMessageFor(data.error));
        if (data.error === "reconnect_required") setSummary((current) => ({ ...current, reconnectRequired: true }));
        return;
      }
      setPreview(data);
    } catch {
      setError("AniList could not be reached. Your Markly library was not changed.");
    } finally {
      setBusy(null);
    }
  }

  async function runImport() {
    setBusy("import");
    setError(undefined);
    try {
      const response = await fetch("/api/integrations/anilist/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ importAnime: selection.anime, importManga: selection.manga }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(errorMessageFor(data.error));
        if (data.error === "reconnect_required") setSummary((current) => ({ ...current, reconnectRequired: true }));
        return;
      }
      setPreview(null);
      setSummary((current) => ({ ...current, lastSyncedAt: new Date().toISOString() }));
    } catch {
      setError("AniList could not be reached. Your Markly library was not changed.");
    } finally {
      setBusy(null);
    }
  }

  async function saveAllowWrites(allow: boolean) {
    setBusy("writePref");
    setError(undefined);
    try {
      const response = await fetch("/api/integrations/anilist/write-preference", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allow }),
      });
      if (!response.ok) {
        setError("Couldn't save that preference. Try again.");
        return;
      }
      setAllowWrites(allow);
    } catch {
      setError("Couldn't save that preference. Try again.");
    } finally {
      setBusy(null);
      setShowEnableWritesConfirm(false);
    }
  }

  function handleWritesToggle(next: boolean) {
    if (next) {
      setShowEnableWritesConfirm(true);
      return;
    }
    void saveAllowWrites(false);
  }

  async function disconnect() {
    setBusy("disconnect");
    setError(undefined);
    try {
      const response = await fetch("/api/integrations/anilist/disconnect", { method: "POST" });
      if (!response.ok) {
        setError("Couldn't disconnect AniList. Try again.");
        return;
      }
      setSummary({ connected: false, provider: "anilist", username: null, lastSyncedAt: null, reconnectRequired: false });
      setPreview(null);
      setAllowWrites(false);
      setDisconnectConfirm(false);
    } catch {
      setError("Couldn't disconnect AniList. Try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-lg border border-border bg-surface p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-foreground">AniList</h2>
          {!summary.connected && <p className="mt-1 text-sm text-muted-foreground">Sync your Anime and Manga library with Markly.</p>}
          {summary.connected && summary.reconnectRequired && <p className="mt-1 text-sm text-danger">Reconnect required</p>}
          {summary.connected && !summary.reconnectRequired && (
            <>
              <p className="mt-1 text-sm text-foreground">Connected as {summary.username}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">Last synced: {formatRelative(summary.lastSyncedAt)}</p>
            </>
          )}
        </div>
      </div>

      {error && <p className="mt-3 text-sm text-danger">{error}</p>}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {!summary.connected && (
          <a
            href="/api/integrations/anilist/connect"
            className="inline-block rounded-md bg-foreground px-3.5 py-2 text-sm font-medium text-background transition-colors hover:bg-foreground/85"
          >
            Connect AniList
          </a>
        )}

        {summary.connected && summary.reconnectRequired && (
          <a
            href="/api/integrations/anilist/connect"
            className="inline-block rounded-md bg-foreground px-3.5 py-2 text-sm font-medium text-background transition-colors hover:bg-foreground/85"
          >
            Reconnect AniList
          </a>
        )}

        {summary.connected && !summary.reconnectRequired && !isFirstImport && (
          <>
            <Button variant="primary" onClick={() => setShowReconcile(true)} disabled={busy !== null}>
              Sync Now
            </Button>
            {!disconnectConfirm ? (
              <Button variant="ghost" onClick={() => setDisconnectConfirm(true)} disabled={busy !== null}>
                Disconnect
              </Button>
            ) : (
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Disconnect AniList? Imported items stay in Markly.</span>
                <button
                  type="button"
                  onClick={disconnect}
                  disabled={busy !== null}
                  className="min-w-24 rounded-md border border-danger/40 px-2.5 py-1 text-xs font-medium text-danger transition-colors hover:bg-danger/10 disabled:opacity-60"
                >
                  {busy === "disconnect" ? "Disconnecting…" : "Confirm"}
                </button>
                <button
                  type="button"
                  onClick={() => setDisconnectConfirm(false)}
                  className="rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                >
                  Cancel
                </button>
              </div>
            )}
          </>
        )}

        {summary.connected && !summary.reconnectRequired && isFirstImport && !preview && (
          <Button variant="primary" onClick={runPreview} disabled={busy !== null} className="min-w-36">
            {busy === "preview" ? "Loading…" : "Preview Library"}
          </Button>
        )}
      </div>

      {summary.connected && !summary.reconnectRequired && !isFirstImport && (
        <div className="mt-4 border-t border-border pt-4">
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">Write Access</p>
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm text-foreground">Allow Markly to update AniList</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                A reviewed Sync Now can send progress, status, and rating changes. Markly never sends anything on its own.
              </p>
            </div>
            <Switch
              checked={allowWrites}
              disabled={busy !== null}
              onChange={handleWritesToggle}
              aria-label="Allow Markly to update AniList"
            />
          </div>

          {showEnableWritesConfirm && (
            <div className="mt-2 rounded-md border border-border bg-surface-hover p-3">
              <p className="text-sm text-foreground">Allow Markly to update AniList?</p>
              <p className="mt-1 text-xs text-muted-foreground">
                When you review and confirm a sync, Markly will be able to update progress, status, and ratings on your AniList list.
              </p>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={() => setShowEnableWritesConfirm(false)}
                  className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground hover:bg-surface"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => saveAllowWrites(true)}
                  disabled={busy !== null}
                  className="rounded-md bg-foreground px-2.5 py-1 text-xs font-medium text-background hover:bg-foreground/85 disabled:opacity-60"
                >
                  {busy === "writePref" ? "Saving…" : "Allow updates"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {preview && (
        <div className="mt-4 rounded-md border border-border p-3">
          <p className="text-sm text-foreground">
            AniList connected as {preview.username}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Found: Anime {preview.anime} · Manga {preview.manga}
          </p>
          <div className="mt-3 space-y-2">
            <label className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={selection.anime}
                onChange={(event) => setSelection((current) => ({ ...current, anime: event.target.checked }))}
              />
              Anime ({preview.anime})
            </label>
            <label className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={selection.manga}
                onChange={(event) => setSelection((current) => ({ ...current, manga: event.target.checked }))}
              />
              Manga ({preview.manga})
            </label>
          </div>
          <Button
            variant="primary"
            onClick={runImport}
            disabled={busy !== null || (!selection.anime && !selection.manga)}
            className="mt-3 min-w-28"
          >
            {busy === "import" ? "Importing…" : "Continue"}
          </Button>
        </div>
      )}

      {showReconcile && (
        <AniListReconcilePanel
          onClose={() => setShowReconcile(false)}
          onApplied={() => setSummary((current) => ({ ...current, lastSyncedAt: new Date().toISOString() }))}
        />
      )}
    </div>
  );
}

function errorMessageFor(code: string | undefined): string {
  switch (code) {
    case "reconnect_required":
      return "Your AniList connection needs to be renewed.";
    case "rate_limited":
      return "AniList is rate-limiting requests right now. Try again shortly.";
    case "not_connected":
      return "AniList isn't connected.";
    case "not_configured":
      return "AniList isn't configured for this deployment yet.";
    default:
      return "AniList could not be reached. Your Markly library was not changed.";
  }
}
