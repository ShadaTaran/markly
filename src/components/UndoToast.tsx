"use client";

import { XIcon } from "@/components/icons";

interface UndoToastProps {
  message: string;
  onUndo?: () => void;
  onDismiss: () => void;
}

/** A minimal, from-scratch toast (no toast/notification infra existed in the codebase before Stage 28) for the Delete/Merge Undo affordance. `onUndo` is omitted for a result toast (e.g. "Undone." or a conflict message) that has nothing left to undo. */
export function UndoToast({ message, onUndo, onDismiss }: UndoToastProps) {
  return (
    <div className="fixed inset-x-0 bottom-4 z-50 flex justify-center px-4">
      <div className="flex max-w-sm items-center gap-3 rounded-md border border-border bg-foreground px-4 py-2.5 text-sm text-background shadow-lg">
        <span className="min-w-0">{message}</span>
        {onUndo && (
          <button
            type="button"
            onClick={onUndo}
            className="shrink-0 font-medium underline underline-offset-2 hover:no-underline"
          >
            Undo
          </button>
        )}
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="shrink-0 text-background/60 transition-colors hover:text-background"
        >
          <XIcon width={14} height={14} />
        </button>
      </div>
    </div>
  );
}
