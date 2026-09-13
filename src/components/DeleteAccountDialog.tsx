import { useId, useState } from "react";
import { Dialog } from "@/components/Dialog";
import { Button } from "@/components/Button";
import { Field, inputClass } from "@/components/FormField";

const CONFIRMATION_PHRASE = "DELETE";

interface DeleteAccountDialogProps {
  isOpen: boolean;
  email: string;
  onCancel: () => void;
  onConfirm: () => void;
  busy: boolean;
  error?: string;
}

/**
 * Stage 43 — the explicit, deliberate confirmation this destructive action
 * requires (no one-click delete, no browser confirm()). Reuses the shared
 * Dialog primitive for its already-audited accessibility contract (role,
 * aria-modal, focus trap, Escape, focus restore — see Dialog.tsx) and the
 * shared Field/inputClass primitives for a properly labeled confirmation
 * input, matching every other form in the app.
 */
export function DeleteAccountDialog({ isOpen, email, onCancel, onConfirm, busy, error }: DeleteAccountDialogProps) {
  const [typed, setTyped] = useState("");
  const inputId = useId();
  const canConfirm = typed === CONFIRMATION_PHRASE && !busy;

  function handleCancel() {
    setTyped("");
    onCancel();
  }

  return (
    <Dialog isOpen={isOpen} onClose={handleCancel} title="Delete your account?" widthClassName="max-w-sm">
      <div className="space-y-3 text-sm text-muted-foreground">
        <p>
          This permanently deletes your Markly account (<span className="text-foreground">{email}</span>) and all of
          your Markly cloud data — library items, sources, collections, activity, reminders, and connected-service
          credentials stored by Markly. You will no longer be able to sign in to this account.
        </p>
        <p>
          Markly does not delete or disconnect your account on any external service such as AniList — only Markly&rsquo;s
          own stored copy of that connection is removed.
        </p>
        <p>
          Any Markly data you use only in this browser while signed out (local library, local reminders) is separate
          from your cloud account and is not affected by this.
        </p>
        <p className="font-medium text-foreground">This can&rsquo;t be undone.</p>
      </div>

      <div className="mt-4">
        <Field label={`Type ${CONFIRMATION_PHRASE} to confirm`} htmlFor={inputId} required>
          <input
            id={inputId}
            type="text"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            className={inputClass(false)}
          />
        </Field>
      </div>

      {error && (
        <p role="alert" className="mt-3 text-sm text-red-500">
          {error}
        </p>
      )}

      <div className="mt-5 flex items-center justify-end gap-2">
        <Button variant="secondary" onClick={handleCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant="destructive" onClick={onConfirm} disabled={!canConfirm}>
          {busy ? "Deleting…" : "Delete account"}
        </Button>
      </div>
    </Dialog>
  );
}
