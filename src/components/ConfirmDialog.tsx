import { Dialog } from "@/components/Dialog";

interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
  danger?: boolean;
}

/** A small, generic Yes/No confirmation — used wherever an action needs a plain "are you sure" without a full Stage 28 recovery flow (e.g. deleting a reminder rule itself — see README "Reminders & Notification Center" §"Delete"). */
export function ConfirmDialog({ isOpen, title, message, confirmLabel, onCancel, onConfirm, danger }: ConfirmDialogProps) {
  return (
    <Dialog isOpen={isOpen} onClose={onCancel} title={title} widthClassName="max-w-sm">
      <p className="text-sm text-muted-foreground">{message}</p>
      <div className="mt-5 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-border px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className={
            danger
              ? "rounded-md bg-danger px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-danger-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40"
              : "rounded-md bg-foreground px-3.5 py-2 text-sm font-medium text-background transition-colors hover:bg-foreground/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          }
        >
          {confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}
