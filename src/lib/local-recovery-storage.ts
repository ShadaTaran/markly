import type { RecoveryEntry } from "@/lib/library-recovery";
import { isRecoveryExpired } from "@/lib/library-recovery";

const RECOVERY_STORAGE_KEY = "markly.recovery";

/** Generous for "recent recoverable actions" purposes — entries also expire after 15 minutes regardless, so this only bounds how many can pile up within one window. */
const MAX_RECOVERY_ENTRIES = 20;

function isValidRecoveryEntry(value: unknown): value is RecoveryEntry {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    (candidate.actionType === "delete_item" || candidate.actionType === "merge_items") &&
    typeof candidate.title === "string" &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.expiresAt === "string" &&
    !!candidate.payload &&
    typeof candidate.payload === "object"
  );
}

function readAll(): RecoveryEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RECOVERY_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidRecoveryEntry);
  } catch {
    return [];
  }
}

function writeAll(entries: RecoveryEntry[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(RECOVERY_STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Storage unavailable (e.g. private browsing, quota exceeded); the
    // action this was recording still succeeded, it just won't be
    // recoverable — no worse than not having Undo at all.
  }
}

/**
 * Reads every still-usable recovery entry, opportunistically dropping
 * expired ones as a side effect — mirroring the cloud RPCs' own "delete
 * this user's expired rows before acting" step, but piggybacked on the
 * next read/write here instead of a request to the server. No background
 * timer: an entry past its expiry simply stops being returned/restorable
 * the next time anything looks.
 */
export function loadRecoveryActions(): RecoveryEntry[] {
  const all = readAll();
  const live = all.filter((entry) => !isRecoveryExpired(entry));
  if (live.length !== all.length) writeAll(live);
  return live.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function addRecoveryAction(entry: RecoveryEntry): void {
  const live = readAll().filter((existing) => !isRecoveryExpired(existing));
  writeAll([entry, ...live].slice(0, MAX_RECOVERY_ENTRIES));
}

export function removeRecoveryAction(id: string): void {
  writeAll(readAll().filter((entry) => entry.id !== id));
}

/** Looks up one entry by id for Undo. Returns null (and opportunistically evicts it) if it's gone or expired — the caller treats that exactly like the cloud RPC's "not_found"/"expired" statuses. */
export function getRecoveryAction(id: string): RecoveryEntry | null {
  const entry = readAll().find((candidate) => candidate.id === id);
  if (!entry) return null;
  if (isRecoveryExpired(entry)) {
    removeRecoveryAction(id);
    return null;
  }
  return entry;
}
