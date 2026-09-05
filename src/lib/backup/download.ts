import type { MarklyBackupV1 } from "@/types/backup";

/** `markly-backup-YYYY-MM-DD.json`, in the local timezone (matches what the user sees on screen, not UTC). */
export function backupFileName(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `markly-backup-${year}-${month}-${day}.json`;
}

/**
 * A normal client-side Blob download — no file-generation dependency
 * needed. Pretty-printed for small backups (genuinely useful for a user
 * who opens the file to look at it); compact for large ones, since 2-space
 * indentation on thousands of records adds real, unnecessary bytes with
 * no readability benefit at that size.
 */
export function downloadBackupFile(backup: MarklyBackupV1): void {
  const recordCount = backup.data.libraryItems.length + backup.data.collections.length + backup.data.activityEvents.length;
  const json = recordCount > 500 ? JSON.stringify(backup) : JSON.stringify(backup, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = backupFileName();
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}
