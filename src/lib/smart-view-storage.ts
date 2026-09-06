import type { SavedSmartView } from "@/types/smart-view";
import { parseSmartViewDefinition } from "@/lib/smart-views";

const SMART_VIEWS_STORAGE_KEY = "markly.smartViews";

function isValidSavedSmartView(value: unknown): value is SavedSmartView {
  if (!value || typeof value !== "object") return false;

  const candidate = value as Record<string, unknown>;

  const hasRequiredFields =
    typeof candidate.id === "string" && typeof candidate.name === "string" && typeof candidate.createdAt === "string";
  if (!hasRequiredFields) return false;
  if (candidate.updatedAt !== undefined && typeof candidate.updatedAt !== "string") return false;

  return parseSmartViewDefinition(candidate.definition) !== null;
}

function readJsonArray(key: string): unknown[] | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;

    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Loads Smart Views from markly.smartViews — a failure domain entirely
 * separate from markly.library/markly.collections/markly.activity.
 * Missing key or malformed top-level JSON both resolve to "no saved views
 * yet" (an empty list); one malformed record (or one with an
 * unsupported/corrupted definition) is dropped individually rather than
 * failing the whole array, so a single bad row never hides the rest
 * (Stage 31 §72).
 */
export function loadSmartViews(): SavedSmartView[] | null {
  if (typeof window === "undefined") return null;

  const raw = readJsonArray(SMART_VIEWS_STORAGE_KEY);
  if (!raw) return null;

  return raw.filter(isValidSavedSmartView).map((view) => ({ ...view, definition: parseSmartViewDefinition(view.definition)! }));
}

export function saveSmartViews(views: SavedSmartView[]): void {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(SMART_VIEWS_STORAGE_KEY, JSON.stringify(views));
  } catch {
    // Storage unavailable (e.g. private browsing, quota exceeded); ignore.
    // This never touches any other markly.* store — each is saved independently.
  }
}
