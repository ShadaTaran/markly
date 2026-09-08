import { Dialog } from "@/components/Dialog";
import { Button } from "@/components/Button";

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
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant={danger ? "destructive" : "primary"} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}
