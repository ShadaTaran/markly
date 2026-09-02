import "server-only";

/**
 * Server-side, authoritative validation/bounding for the optional
 * `detectedMetadata` field on an incoming progress request — the
 * extension applies the same bounds itself (see
 * extension/src/tracking/universal/detected-metadata.ts) but that's only
 * a courtesy; nothing from the request body is trusted until it passes
 * this. A missing or entirely-invalid `detectedMetadata` is not an
 * error — it just means no enrichment happens for this request (see
 * lib/extension/enrichment.ts).
 */
export interface DetectedMetadata {
  workUrl?: string;
  coverUrl?: string;
  authors?: string[];
  description?: string;
  genres?: string[];
}

const MAX_URL_LENGTH = 2000;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_AUTHORS = 5;
const MAX_AUTHOR_LENGTH = 100;
const MAX_GENRES = 8;
const MAX_GENRE_LENGTH = 40;

function parseHttpUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL_LENGTH) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function parseDescription(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, MAX_DESCRIPTION_LENGTH) : undefined;
}

function parseStringList(value: unknown, maxItems: number, maxItemLength: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const items: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim().slice(0, maxItemLength);
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(trimmed);
    if (items.length >= maxItems) break;
  }
  return items.length > 0 ? items : undefined;
}

/** Returns null (never throws) for anything malformed — a request should never fail just because detectedMetadata is absent or garbled; it just means no enrichment. */
export function parseDetectedMetadata(raw: unknown): DetectedMetadata | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Record<string, unknown>;

  const workUrl = parseHttpUrl(candidate.workUrl);
  const coverUrl = parseHttpUrl(candidate.coverUrl);
  const description = parseDescription(candidate.description);
  const authors = parseStringList(candidate.authors, MAX_AUTHORS, MAX_AUTHOR_LENGTH);
  const genres = parseStringList(candidate.genres, MAX_GENRES, MAX_GENRE_LENGTH);

  if (!workUrl && !coverUrl && !description && !authors && !genres) return null;

  return {
    ...(workUrl && { workUrl }),
    ...(coverUrl && { coverUrl }),
    ...(description && { description }),
    ...(authors && { authors }),
    ...(genres && { genres }),
  };
}
