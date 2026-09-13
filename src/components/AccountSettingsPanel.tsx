"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/components/AuthProvider";
import { DeleteAccountDialog } from "@/components/DeleteAccountDialog";
import { Button } from "@/components/Button";
import { clearImportBannerDismissedForUser } from "@/hooks/useLocalImport";
import { clearMigrationMarkerForUser } from "@/lib/cloud/migration";

const ERROR_MESSAGES: Record<string, string> = {
  invalid_confirmation: 'Type "DELETE" exactly to confirm.',
  unauthenticated: "Your session has expired. Sign in again and retry.",
  not_configured: "Account deletion isn't available for this deployment yet.",
  auth_delete_failed: "Something went wrong deleting your account. Nothing was changed — you can try again.",
};

/**
 * Stage 43 — Account settings: identity, a pointer to the existing backup
 * export (never duplicated here), and the Danger Zone. Deletion itself is
 * server-authoritative (POST /api/account/delete derives the user from the
 * session, never a client-supplied id) — this panel only collects explicit
 * confirmation and reflects the result.
 */
export function AccountSettingsPanel({ email }: { email: string }) {
  const router = useRouter();
  const { user, signOut } = useAuth();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function handleConfirmDelete() {
    // Captured from the still-current session BEFORE deletion — this is
    // browser-cleanup bookkeeping only, never sent anywhere as deletion
    // authority. The server independently (and exclusively) derives who to
    // delete from its own session check; see /api/account/delete.
    const deletedUserId = user?.id;

    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch("/api/account/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation: "DELETE" }),
      });
      const data: { status?: string; error?: string } = await response.json();

      if (!response.ok || data.status !== "deleted") {
        setError(ERROR_MESSAGES[data.error ?? ""] ?? "Something went wrong deleting your account. Nothing was changed — you can try again.");
        setBusy(false);
        return;
      }

      // Deletion is now confirmed server-side (account + all Markly cloud
      // data are already gone) — only now is it safe to remove this one
      // deleted user's two account-specific localStorage flags. Both
      // helpers are best-effort/non-throwing and touch only that one
      // userId's own key; local-mode data (markly.library, markly.theme,
      // markly.activity, etc.) is a single global key, never per-account,
      // and is never touched here.
      if (deletedUserId) {
        clearImportBannerDismissedForUser(deletedUserId);
        clearMigrationMarkerForUser(deletedUserId);
      }

      // signOut() reuses the exact same logout mechanism as the header's
      // own Sign Out — including its existing best-effort browser
      // PushSubscription cleanup — so nothing is reimplemented here.
      setDialogOpen(false);
      await signOut();
      router.push("/");
      router.refresh();
    } catch {
      // The fetch/JSON-parsing itself failed — no "deleted" status was ever
      // received, so nothing above ran: no localStorage flag was touched
      // and signOut/redirect never happened. Report failure honestly.
      setError("Couldn't reach Markly to delete your account. Nothing was changed — check your connection and try again.");
      setBusy(false);
    }
  }

  return (
    <div className="space-y-8">
      <section>
        <h2 className="text-base font-semibold text-foreground">Signed in as</h2>
        <p className="mt-1 text-sm text-muted-foreground">{email}</p>
      </section>

      <section>
        <h2 className="text-base font-semibold text-foreground">Export your data</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Before making any permanent changes, you can export a full backup of your Markly library.
        </p>
        <Link
          href="/settings/backup"
          className="mt-3 inline-block rounded-md border border-border px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-surface-hover"
        >
          Go to Data &amp; Backup
        </Link>
      </section>

      <section className="rounded-lg border border-red-500/30 p-4">
        <h2 className="text-base font-semibold text-foreground">Danger Zone</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Permanently delete your Markly account and all of your Markly cloud data. This cannot be undone.
        </p>
        <Button
          variant="destructive"
          className="mt-3"
          onClick={() => {
            setError(undefined);
            setDialogOpen(true);
          }}
        >
          Delete account
        </Button>
      </section>

      <DeleteAccountDialog
        isOpen={dialogOpen}
        email={email}
        onCancel={() => {
          if (!busy) setDialogOpen(false);
        }}
        onConfirm={() => void handleConfirmDelete()}
        busy={busy}
        error={error}
      />
    </div>
  );
}
